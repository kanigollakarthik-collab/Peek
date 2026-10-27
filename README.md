# Peek

**See returns, bank offers, warranty, and answers to your own questions on every Amazon.in search result, without opening a single product page.**

A Chrome extension backed by a Node/Express + MongoDB service that reads each product page for you and puts the answers on the search results.

---

## Problem Statement

On Amazon.in the search results page only shows a title, price and rating. The details people actually decide on, like *Is it returnable or replacement-only? Is there an HDFC card offer? How long is the warranty? Does it support ANC?*, are buried inside each product page. Comparing 20 products means opening 20 tabs and hunting through each one.

Existing tools either answer one fixed question (return-policy checkers) or work on one product at a time (AI shopping sidebars). Nothing answers *any* question across *all* results at once.

## Target Users

Online shoppers on Amazon.in who compare several similar products before buying (electronics, appliances, accessories) and care about return terms, card offers and specific features.

## Solution

Peek runs on the search results page. For every result it reads the product page in the background, cuts it down to the useful parts, and has an AI model extract a fixed set of facts. The answer appears right on the result card. You can also type your own question once and get an answer on every card.

Behind it, a server pools many free-tier AI keys into one reliable service (the **LLM API tree**), caches every answer in MongoDB so repeat searches are instant, and keeps each user's question history.

## Key Features (workflows)

1. **Create an account and sign in** from the extension popup. Passwords are hashed, sessions are signed tokens that expire, and the shared server secrets never reach the browser.
2. **Search on Amazon.in.** Every result card shows returns (colour-coded: return, replacement only, or non-returnable), bank offer and warranty. Cached products appear instantly. Others fill in as they are read, with progress shown in the Peek box.
3. **Ask your own question** ("Is it waterproof?") in the Peek box. Every card gets a short answer taken only from that product's page, or *Not mentioned on the product page*.
4. **Re-use your question history.** The popup lists your recent questions (de-duplicated, with counts). Click one to ask it again on the open search, or clear your history.
5. **Admin monitoring** (developer tool): a React dashboard shows every AI key's health, quota use, latency and errors, plus cache hit rate. Only admin accounts or the admin token can open it.

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Client | Chrome Extension, Manifest V3, plain JavaScript, Shadow DOM | Runs where the user already shops; Shadow DOM keeps Amazon's CSS and ours apart |
| Server | Node.js 22, Express 4 | Streams results per product (NDJSON); small enough for a 1 GB free VM |
| Database | MongoDB Atlas (free M0) via Mongoose | Users, question history, product-facts cache and answer cache, with TTL expiry |
| Auth | bcryptjs, JSON Web Tokens | Hashed passwords; stateless, expiring sessions |
| AI | Google Gemini and Gemma models plus Groq, through one OpenAI-compatible adapter | All free tiers, pooled by the router |
| Admin UI | React 18 + Vite | Live view of the API tree |
| Hosting | Self-managed Oracle Cloud free VM (Hyderabad), PM2, Caddy (automatic HTTPS) | Always on, no time limits, close to users, $0 (see [Why our own server](#why-our-own-server)) |

## Architecture

```
Chrome extension (amazon.in)                         Peek server (Oracle VM, behind Caddy HTTPS)
┌───────────────────────────────┐   HTTPS + JWT     ┌──────────────────────────────────────────┐
│ popup: sign in / history /    │ ───────────────►  │ /api/auth/*   bcrypt + JWT, login limiter │
│        settings               │                   │ /api/me/*     question history            │
│ content script:               │                   │ /api/lookup   cache check (MongoDB)       │
│  find result cards            │                   │ /api/extract  facts per product ─┐        │
│  fetch product pages (user's  │  ◄── NDJSON ───── │ /api/ask      answers per product ┤        │
│   own session, 8 in parallel) │   one line per    │                                   ▼        │
│  clean page to ~3.5 KB text   │   product         │  per-user hourly quota → batcher →        │
│  render badges, retry busy    │                   │  LLM API tree (router) → cache            │
│ service worker: adds the      │                   │ /api/stats    admin only → React dashboard│
│  user's token, streams results│                   └──────────────────────────────────────────┘
└───────────────────────────────┘                               │
                                                                ▼
                                    Gemini key×model slots, Gemma, Groq, … (free tiers)
```

### The interesting engineering

- **LLM API tree** (`server/src/llm/router.js`). Every (provider, key, model) is a *slot* with its own requests-per-minute, tokens-per-minute and per-day budget. Requests go to the best slot with quota left. On a 429 the slot cools down for the time the provider asks for, and a daily-quota 429 benches it for an hour. Retired models (404/410) are benched for 30 minutes. Slow calls get a backup request on another slot. When every slot is busy, requests wait up to 60 s instead of failing. Gemini limits apply per model per project, so adding models and project keys multiplies capacity.
- **Extract once, answer many.** One AI call per product extracts a fixed schema (return type and days, policy, bank offer, other offers, warranty, delivery, seller, key specs). It is cached by ASIN for 48 h and shared by all users. Custom answers are cached per (ASIN, question).
- **Reliability over speed.** One product per AI call by default (`BATCH_SIZE=1`) so the model can't mix up products. Batching up to 4 is available. A product whose slot stays busy is retried by the extension after 10, 30 and 60 s. Pattern-based hints (for example "10 days replacement") show instantly while the AI answers.
- **Page cleaning** (`extension/src/amazon.js`). Product HTML (1–2 MB) is stripped of scripts and styles before parsing, then reduced to prioritised sections (title, price, offers, returns, delivery, seller, warranty, specs) within a 3,500-character budget, with a fallback for unknown layouts.
- **Streaming.** The server writes one JSON line per product as soon as it is ready, so cards fill progressively.
- **Abuse protection.** A per-user hourly quota on uncached AI calls, a limit on failed logins per IP and email, an optional signup code, validated input, and admin-only stats.

### Data model (MongoDB)

| Collection | Fields | Notes |
|---|---|---|
| `users` | email (unique, lowercase), passwordHash (bcrypt), role (`user`/`admin`), createdAt, lastLoginAt | |
| `questions` | userId, key (normalised question), question, timesAsked, lastAskedAt | unique (userId, key) |
| `products` | _id = ASIN, title, cleaned text, rule hints, facts, provider, updatedAt | TTL index, 48 h |
| `answers` | asin, question (normalised), answer, evidence, provider, createdAt | unique (asin, question), TTL 48 h |

### Error handling

| Situation | What the user sees |
|---|---|
| Not signed in, or session expired | Peek box: "Sign in…"; the popup asks to sign in again |
| Wrong password / too many attempts | "Wrong email or password" / "Too many failed attempts. Try again in 15 minutes." |
| Duplicate email, weak password, bad email | Clear message on the form |
| Every AI key busy | Card shows "AI keys busy, retry 1 of 3…" and retries automatically |
| AI unavailable after retries | Card keeps the page-based hints with an "AI unavailable" note |
| Hourly limit reached | Warning in the Peek box; cached answers keep working |
| Amazon throttling / CAPTCHA | Fetching slows down, pauses and retries; then "Amazon blocked this request" |
| Server unreachable | "Can't reach the Peek server" in the popup and the Peek box |
| Invalid JSON / oversized requests | 400 / 413 with a readable message |

## Install the extension (for testers)

1. Download `peek-extension.zip` from this repository's **Releases** page and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose the unzipped folder.
3. Pin Peek from the puzzle-piece menu, click its icon, and **Create account**.
4. Search for anything on [amazon.in](https://www.amazon.in), for example *bluetooth earbuds*. Answers appear on each result. Type a question in the Peek box at the bottom right to ask every product.

## Local Setup

Requirements: Node.js 20+, Chrome. MongoDB is optional locally (without it, data is kept in memory).

```bash
cd server
cp .env.example .env        # set JWT_SECRET and at least one AI key
npm install
npm run test:router         # router tests, no keys needed
npm run check:models        # checks every configured key and model
npm start                   # http://localhost:8080
```

Dashboard (optional, for admins):

```bash
cd dashboard
npm install
npm run dev                 # http://localhost:5173, proxies /api to :8080
```

Extension: in `extension/src/settings.js` set `PEEK_SERVER_URL` to `http://localhost:8080` (or change it in the popup under *Advanced*), then load the `extension/` folder unpacked as above.

## Environment Variables

All in `server/.env` (template: `server/.env.example`). **Never commit `.env`.** It is git-ignored.

| Variable | Required | Purpose |
|---|---|---|
| `JWT_SECRET` | yes | Signs login tokens; at least 32 random characters (`openssl rand -hex 32`) |
| `MONGODB_URI` | for deployment | MongoDB Atlas connection string |
| `GEMINI_API_KEYS` | at least one AI key | Comma-separated, **one key per Google Cloud project** |
| `GEMINI_MODELS` | no | Gemini/Gemma models to use; each becomes its own slot |
| `GROQ_API_KEYS`, `MISTRAL_API_KEYS`, `OPENROUTER_API_KEYS`, … | no | Extra free providers (see `.env.example`) |
| `ADMIN_TOKEN` | no | Lets the dashboard read stats; never put it in the extension |
| `ADMIN_EMAILS` | no | Accounts with these emails become admins |
| `SIGNUP_CODE` | no | If set, creating an account requires this code |
| `USER_HOURLY_LIMIT` | no | New AI answers per user per hour (default 300) |
| `TOKEN_DAYS` | no | How long a sign-in lasts (default 30) |
| `HOST`, `PORT` | no | Bind address/port (`HOST=127.0.0.1` behind Caddy) |
| `BATCH_SIZE`, `LLM_TIMEOUT_MS`, `LLM_HEDGE_MS`, `LLM_MAX_ATTEMPTS`, `LLM_QUEUE_MS` | no | Router tuning |

## Deployment

### Why our own server

The easy route would have been a one-click host such as Vercel or Render. We weighed the trade-offs and chose to run our own Linux server instead, because Peek's core design depends on things those free plans don't give:

| What Peek needs | Vercel (serverless) | Render (free) | Our Oracle VM |
|---|---|---|---|
| **One process that remembers.** The LLM API tree keeps every key's rate counters, cooldowns and the waiting queue in memory. | Many short-lived copies that forget between requests; state would have to move to Redis | Memory is wiped every time the service sleeps | One process, always running |
| **Long requests.** A 20-product search can wait up to 60 s for a free AI key and streams results for its whole length. | Function time limits cut it off | Works | Works |
| **Always available.** A tester should get answers on the first try. | Yes | Sleeps after ~15 min idle; the first request then waits 30–60 s | Always on, restarts itself after a crash or reboot |
| **Close to users.** Shoppers and Amazon.in are in India. | One region per project | Nearest is Singapore | Hyderabad |
| **Room to grow.** Rotating proxies and background cache warming (see [Future Work](#future-work)) are long-running jobs. | Not possible on free functions | Limited by sleep | Ready |

It also cost $0, the same as the hosted options. The price was doing the operations work ourselves:

- **Provisioning a 1 GB VM.** Added 2 GB of swap so `npm install` and the dashboard build don't run out of memory. Installed Node 22 (`deploy/setup-oracle.sh`).
- **Process management.** PM2 keeps the server running, restarts it if it crashes, and starts it at boot (`deploy/ecosystem.config.cjs`).
- **Networking.** Oracle's Ubuntu images block every port by default, so we opened the OS firewall (iptables, saved across reboots) and the cloud's VCN security list.
- **A domain and HTTPS.** We used a free DuckDNS name and Caddy as a reverse proxy, which gets and renews Let's Encrypt certificates automatically. Caddy is set to pass each streamed line through immediately so cards still fill one by one (`deploy/setup-https.sh`).
- **Hardening.** The Node app listens on `127.0.0.1` only, so the only way in is through HTTPS. Secrets live only in `server/.env` on the server, and `trust proxy` is set so per-IP login limits see the real client address.
- **Debugging it live.** Along the way we fixed MongoDB Atlas authentication and connection-string issues, blocked ports, and providers retiring models (now detected by `npm run check:models`).

All of it is scripted, so the whole server can be rebuilt from a fresh VM with three commands.

### Setting it up

**Server:** an Oracle Cloud free micro VM (Ubuntu, Hyderabad).

```bash
git clone https://github.com/kanigollakarthik-collab/ezshopping.git peek && cd peek
bash deploy/setup-oracle.sh            # swap, Node 22, PM2, build, start
nano server/.env                       # JWT_SECRET, MONGODB_URI, AI keys
bash deploy/setup-https.sh <your-domain>   # Caddy + Let's Encrypt; app then listens on localhost only
```

Open TCP 80 and 443 in the instance's VCN security list. A free domain from [DuckDNS](https://www.duckdns.org) pointing at the VM's IP works.

**Extension build:** set `PEEK_SERVER_URL` in `extension/src/settings.js` to the HTTPS address, zip the `extension` folder, and attach the zip to a GitHub Release. In PowerShell:

```powershell
Compress-Archive -Path extension\* -DestinationPath peek-extension.zip -Force
```

**Updating the server:**

```bash
cd ~/peek && git pull && (cd server && npm ci --omit=dev) && (cd dashboard && npm ci && npm run build) && pm2 restart peek
```

## Project Structure

```
extension/   Chrome extension: content script, Amazon page parsing, UI, popup, service worker
server/      Express API: auth, store, cache, LLM router, prompts, batcher, scripts/ (tests, model check)
dashboard/   React admin dashboard (built into dashboard/dist, served by the server)
deploy/      Oracle VM setup, HTTPS (Caddy), PM2 config
```

## Limitations

- Amazon.in only. Amazon changes its page layout, so section selectors in `extension/src/amazon.js` may need updates; a generic text fallback covers unknown layouts.
- Free AI tiers limit throughput. A cold search of 20 products can take tens of seconds when quotas are tight; repeat searches are served from the cache.
- Answers are only as good as what the product page states; Peek says *Not stated* rather than guessing.
- The extension is loaded unpacked (Chrome Web Store publishing costs a fee).

## Future Work

### Read the data hidden behind pop-ups and "See more"

Today Peek reads what is in the product page's HTML when it first loads. Some of the most useful details are not there yet. Amazon loads them only when you click:

- **Bank offers.** The offer cards show a one-line summary. The full list, card types, minimum order value and the terms open in a side sheet.
- **Returns policy.** The "10 days Replacement" icon opens a pop-up with the actual conditions (what counts as damaged, whether opened items qualify).
- **EMI, exchange and protection plans.** These open in their own pop-ups.
- **Delivery for your pincode, and other sellers' offers** ("See all buying options"), which can have different returns and warranty.

Plan:
1. In the fetched page, find the pop-up triggers. Amazon's pop-up markup usually names the address its content loads from (for example in a `data-a-popover` attribute).
2. Fetch those addresses from the same tab and session, with the same pacing and retry rules as product pages.
3. Clean the result and add it to the matching section ("Offers", "Returns and services") before the text goes to the AI, within the size budget.
4. Cache it with the product, so the extra requests happen once per product, not once per user.

Hidden-but-present content, such as collapsed "See more" specs, gets the same treatment: keep it, and drop only scripts and styles.

### Rotating proxies and server-side fetching

Product pages are fetched by the user's own browser today. That is simple and free, but it means:
- Amazon can slow down or show a CAPTCHA to a heavy user.
- Nothing can be fetched unless someone has the search open.

Plan:
- **Fetch on the server through a pool of rotating proxies.** Every proxy becomes a *slot*, just like the AI keys in the LLM API tree: health checks, cooldown after a block or CAPTCHA, and failover to the next proxy. The existing router design carries over almost unchanged.
- **Warm the cache ahead of time.** Fetch popular searches and products in the background, so most results are instant for everyone.
- **Keep the browser as a fallback.** Use it when the proxy pool is empty, and keep it for anything that depends on the user's location or account (pincode delivery, Prime).

### Other ideas

- **Filter and sort by the answers**, for example "hide non-returnable" or "only items with an HDFC offer".
- **Compare view:** a table of the facts for chosen products, side by side.
- **Answer feedback:** a "wrong answer" button that drops the cached answer and re-reads the page, plus a dashboard metric for it.
- **Variant awareness:** colour and size variants can have different sellers and offers. Read them per variant ASIN.
- **More stores** (for example Flipkart) through a per-site adapter like `amazon.js`. The server and the AI router need no change.
- **Selector health:** have the dashboard track how often the generic fallback is used, as an early warning that Amazon changed its layout.
- **Chrome Web Store release and CI:** run the router and API tests on every push.

## AI Usage

AI assistants were used for brainstorming, code generation, debugging and documentation. Every part was reviewed, tested (router tests, end-to-end API tests, manual tests on Amazon.in) and integrated by the author.
