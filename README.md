# SOMS — Smart Office Management System

A simulated smart-office platform: a real-time backend (REST + WebSocket),
a dashboard, ESP32 hardware-node firmware, and Discord/Telegram bots for
remote monitoring and control.

## Project layout

```
SOMS-v2/
├── soms-backend/          Express + WebSocket API, simulator, encrypted datastore
│   └── src/
│       ├── security/      crypto.js (AES-256-GCM, HMAC), auth.js (auth middleware)
│       ├── routes/        REST route handlers
│       ├── rules/         Alerting + automation rules
│       ├── ws/            WebSocket broadcaster
│       ├── db.js          Encrypted-at-rest JSON store
│       └── server.js      App entrypoint
├── soms-discord-bot/       Discord control/notification bot
├── soms-telegram-bot/      Telegram control/notification bot
├── soms-frontend-wired/    Built dashboard (static)
├── hardware/               ESP32 firmware + Wokwi simulation
├── diagrams/               System architecture diagram
├── scripts/
│   ├── setup-env.js        Creates .env files with unique generated secrets
│   └── generate-secrets.js Prints a fresh set of secrets on demand
├── docker-compose.yml
├── SECURITY.md             What's protected, how, and the honest limits
└── .env.example            Root-level env for docker-compose
```

## Quick start (local dev)

```bash
npm install
npm run setup          # creates .env files per service with unique secrets
# fill in DISCORD_TOKEN / TELEGRAM_BOT_TOKEN in the respective .env files
npm run dev:all        # backend + frontend + both bots
```

## Quick start (Docker)

```bash
cp .env.example .env
node scripts/generate-secrets.js   # paste AUTH_TOKEN / SOMS_DB_KEY / SOMS_HMAC_SECRET into .env
docker compose up -d --build
```

## Security

See [SECURITY.md](./SECURITY.md) for the full model: encryption at rest,
request signing, rate limiting, and the Discord DM-admin fix. Short
version — every secret is generated, not defaulted; the database is
AES-256-GCM encrypted; bot↔backend traffic is bearer-token authenticated
with optional HMAC request signing; and both bots rate-limit commands per
user.

## Performance notes

- Response compression (`compression`) and security headers (`helmet`)
  are on by default with negligible overhead relative to network latency.
- The datastore is an in-memory cache with debounced, non-blocking disk
  writes (50ms coalescing window) — reads never touch disk after startup.
- The WebSocket broadcaster sends state **diffs**, not full snapshots, on
  every simulator tick, so per-client bandwidth stays flat as history
  grows.
- For higher throughput than a single Node process, run multiple backend
  replicas behind a load balancer with sticky WebSocket sessions, or use
  Node's `cluster` module — the encrypted datastore's debounced-write
  design is safe for a single writer; scale writers with care (e.g. one
  designated writer instance) if you go this route.
