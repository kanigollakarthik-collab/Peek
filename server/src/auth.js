import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Accounts: bcrypt-hashed passwords, signed JWTs that expire, a "user" and an
// "admin" role, and a limiter against password guessing.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class InputError extends Error {}

export function validateCredentials(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new InputError('Enter a valid email address');
  if (password.length < 8) throw new InputError('Password must be at least 8 characters');
  if (password.length > 128) throw new InputError('Password must be at most 128 characters');
  return { email, password };
}

export const hashPassword = (password) => bcrypt.hash(password, 10);
export const checkPassword = (password, hash) => bcrypt.compare(password, hash);

export function signToken(user, { jwtSecret, tokenDays }) {
  return jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: `${tokenDays}d` });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function authMiddleware({ store, auth }) {
  async function requireUser(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sign in required', code: 'signed_out' });
    let payload;
    try {
      payload = jwt.verify(token, auth.jwtSecret);
    } catch (err) {
      const expired = err.name === 'TokenExpiredError';
      return res.status(401).json({
        error: expired ? 'Session expired, sign in again' : 'Invalid session, sign in again',
        code: expired ? 'expired' : 'invalid',
      });
    }
    const user = await store.findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account not found, sign in again', code: 'invalid' });
    req.user = user;
    next();
  }

  // Admins: an admin account, or the ADMIN_TOKEN header the dev dashboard uses.
  function requireAdmin(req, res, next) {
    const apiKey = req.get('x-api-key');
    if (apiKey && auth.adminToken && safeEqual(apiKey, auth.adminToken)) {
      req.user = { id: 'admin-token', role: 'admin' };
      return next();
    }
    requireUser(req, res, () => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      next();
    });
  }

  return { requireUser, requireAdmin };
}

// Counts failed logins per key (IP + email); blocks after `max` failures until
// the window passes. In memory: resets when the server restarts.
export function createAttemptLimiter({ max = 10, windowMs = 15 * 60_000 } = {}) {
  const fails = new Map();
  const entry = (key) => {
    const e = fails.get(key);
    if (e && Date.now() - e.first > windowMs) {
      fails.delete(key);
      return null;
    }
    return e;
  };
  return {
    blocked: (key) => (entry(key)?.count ?? 0) >= max,
    fail(key) {
      const e = entry(key) || { first: Date.now(), count: 0 };
      e.count++;
      fails.set(key, e);
    },
    reset: (key) => fails.delete(key),
  };
}
