import mongoose from 'mongoose';

// User accounts and each user's question history. Uses MongoDB when it is
// configured (createCache opens the connection), otherwise in-memory maps
// for local development.

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: Date,
  },
  { versionKey: false },
);

// One row per (user, question); asking again bumps the count and time.
const questionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    key: { type: String, required: true }, // normalised, for de-duplication
    question: String, // latest wording the user typed
    timesAsked: Number,
    lastAskedAt: Date,
  },
  { versionKey: false },
);
questionSchema.index({ userId: 1, key: 1 }, { unique: true });
questionSchema.index({ userId: 1, lastAskedAt: -1 });

export class DuplicateError extends Error {}

const publicUser = (u) => u && { id: String(u._id), email: u.email, role: u.role };
const publicQuestion = (q) => ({ question: q.question, timesAsked: q.timesAsked, lastAskedAt: q.lastAskedAt });

export async function createStore({ useMongo }) {
  if (useMongo) {
    const User = mongoose.model('User', userSchema);
    const Question = mongoose.model('Question', questionSchema);
    await Promise.all([User.syncIndexes(), Question.syncIndexes()]);

    return {
      async createUser({ email, passwordHash, role }) {
        try {
          return publicUser(await User.create({ email, passwordHash, role }));
        } catch (err) {
          if (err.code === 11000) throw new DuplicateError('email already registered');
          throw err;
        }
      },
      // Includes passwordHash: only for checking a login.
      findUserByEmail: (email) => User.findOne({ email }).lean(),
      async findUserById(id) {
        if (!mongoose.isValidObjectId(id)) return null;
        return publicUser(await User.findById(id).lean());
      },
      async touchLogin(id) {
        await User.updateOne({ _id: id }, { lastLoginAt: new Date() });
      },
      async recordQuestion(userId, key, question) {
        await Question.updateOne(
          { userId, key },
          { $set: { question, lastAskedAt: new Date() }, $inc: { timesAsked: 1 } },
          { upsert: true },
        );
      },
      async listQuestions(userId, limit = 20) {
        const rows = await Question.find({ userId }).sort({ lastAskedAt: -1 }).limit(limit).lean();
        return rows.map(publicQuestion);
      },
      async clearQuestions(userId) {
        return (await Question.deleteMany({ userId })).deletedCount;
      },
      countUsers: () => User.estimatedDocumentCount(),
    };
  }

  const users = new Map(); // id -> user
  const byEmail = new Map(); // email -> id
  const questions = new Map(); // userId -> Map(key -> question)
  let nextId = 1;

  return {
    async createUser({ email, passwordHash, role }) {
      if (byEmail.has(email)) throw new DuplicateError('email already registered');
      const user = { _id: String(nextId++), email, passwordHash, role, createdAt: new Date() };
      users.set(user._id, user);
      byEmail.set(email, user._id);
      return publicUser(user);
    },
    async findUserByEmail(email) {
      return users.get(byEmail.get(email)) || null;
    },
    async findUserById(id) {
      return publicUser(users.get(String(id)));
    },
    async touchLogin(id) {
      const u = users.get(String(id));
      if (u) u.lastLoginAt = new Date();
    },
    async recordQuestion(userId, key, question) {
      if (!questions.has(userId)) questions.set(userId, new Map());
      const mine = questions.get(userId);
      const row = mine.get(key) || { timesAsked: 0 };
      mine.set(key, { question, timesAsked: row.timesAsked + 1, lastAskedAt: new Date() });
    },
    async listQuestions(userId, limit = 20) {
      return [...(questions.get(userId)?.values() || [])]
        .sort((a, b) => b.lastAskedAt - a.lastAskedAt)
        .slice(0, limit)
        .map(publicQuestion);
    },
    async clearQuestions(userId) {
      const n = questions.get(userId)?.size || 0;
      questions.delete(userId);
      return n;
    },
    countUsers: async () => users.size,
  };
}
