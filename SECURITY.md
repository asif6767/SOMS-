# SOMS Security Model

This document describes what's actually protected, how, and — just as
important — what isn't. No system, including this one, is "unbreakable."
The goal here is to make the realistic attack surface as small and as
well-defended as practically possible, and to be honest about where the
remaining risk lives.

## What changed and why

| Area | Before | Now |
|---|---|---|
| Database at rest | Plaintext JSON file | AES-256-GCM encrypted (confidentiality + tamper-evidence) |
| Bearer token check | `===` string compare | `crypto.timingSafeEqual` (no timing side-channel) |
| Bot ↔ backend traffic | Bearer token only | Bearer token **+ optional HMAC-SHA256 request signing** |
| Brute force on `/api/v1/*` and `/ws/live` | None | Per-IP lockout after repeated failures |
| Discord DM admin access | **Any DM to the bot got full control access** | Requires explicit `DISCORD_OWNER_IDS` allowlist |
| Command flooding (Discord/Telegram) | None | Per-user rate limit (20 commands/min) |
| Transport security | Plain HTTP/WS only | Optional native TLS, or terminate TLS at a reverse proxy (recommended) |
| Response headers | None | `helmet` security headers |
| Default secrets | Hardcoded `soms-dev-token` shipped in `.env.example` | No secret has a working default; `npm run setup:env` generates unique ones |
| Error responses | Occasionally leaked internals | Always a generic message; details only in server logs |

## Encryption at rest (`soms-backend/src/db.js`)

The JSON database (rooms, settings, cost history, audit log, uploaded
avatar) is encrypted with **AES-256-GCM** before it ever touches disk:

- A random 12-byte IV is generated per write.
- The GCM authentication tag is stored alongside the ciphertext, so any
  modification to the file — corruption, tampering, a botched restore from
  an old backup — causes decryption to fail loudly instead of silently
  loading bad data.
- The key (`SOMS_DB_KEY`) is a 32-byte value that never lives in the
  repository. In development, if you don't set it, one is generated once
  and stored at `data/.db.key` with `0600` permissions purely so local dev
  doesn't require manual setup. **In production the server refuses to
  start without an explicit `SOMS_DB_KEY`.**

**What this protects against:** someone getting read access to the raw
`data/` directory (a misconfigured backup, a leaked disk snapshot, a
different tenant on shared hosting) without also having the key.

**What this does not protect against:** someone who has both the
encrypted file *and* `SOMS_DB_KEY`. Key management is the actual security
boundary here — treat `SOMS_DB_KEY` like a password: put it in a secrets
manager (not committed to git, not in Slack), back it up separately from
the database file itself, and rotate it if you ever suspect exposure
(you'll need to re-encrypt the existing data with the old key first).

## Bearer token + request signing (`soms-backend/src/security/`)

- `AUTH_TOKEN` — a shared secret the dashboard and both bots present as
  `Authorization: Bearer <token>`. Compared with `crypto.timingSafeEqual`
  so an attacker can't learn how many characters they got right from
  response timing.
- `SOMS_HMAC_SECRET` (optional, defense in depth) — when set, every
  request must also carry `X-Soms-Signature`, an HMAC-SHA256 over
  `method\npath\nbody`. This binds the signature to that exact request, so
  a captured request (from a log, a proxy, a browser history) can't be
  replayed against a different path or with a modified body.
- Both checks are rate-limited per IP: 10 failures in 60 seconds triggers
  a 5-minute lockout for that IP, independent of the general rate limiter.

**What this protects against:** unauthorized API/WS access, casual replay
of captured requests, and brute-forcing the token.

**What this does not protect against:** someone who already has
`AUTH_TOKEN` (and `SOMS_HMAC_SECRET` if enabled) legitimately — e.g. a
compromised bot host. Rotate these values if a bot's environment is ever
compromised.

## Transport security

This app does not invent its own transport crypto — it relies on TLS,
which is the correct call. Two supported setups:

1. **Reverse proxy (recommended):** put nginx, Caddy, or a cloud load
   balancer in front of `soms-backend`, terminate TLS there, and forward
   plain HTTP/WS to the Node process. This is the standard, well-audited
   way to run any Node service in production.
2. **Native TLS:** set `TLS_KEY_FILE` / `TLS_CERT_FILE` and the backend
   serves HTTPS/WSS directly. Useful for simple single-box deployments
   without a proxy.

Either way: **never expose plain HTTP/WS to the public internet in
production.** `AUTH_TOKEN` sent over unencrypted HTTP is just as visible
to a network observer as no auth at all.

## Discord/Telegram bot linking

Both bots talk to the backend over the same authenticated API, so the
security of "linking" them is really the security of `AUTH_TOKEN` /
`SOMS_HMAC_SECRET` in each bot's `.env`, plus who can issue commands to the
bot itself:

- **Discord:** control commands (device on/off, add/remove rooms, etc.)
  require the "Manage Server" permission or a configured `ADMIN_ROLE_ID`
  role *in a server*. Direct messages to the bot no longer get an
  automatic pass — a previous version of this bot treated any DM as
  trusted, which meant anyone who could find the bot could issue control
  commands from a DM. That's fixed: DM control access now requires being
  listed in `DISCORD_OWNER_IDS`, and if that's left blank, DM control is
  simply unavailable.
- **Telegram:** control commands require the sender's numeric user ID to
  be listed in `ADMIN_CHAT_IDS` (unchanged — this was already correct).
- **Both bots** now rate-limit commands per user (20/minute) to blunt
  command-flooding or a compromised/careless integration hammering the
  backend.

## Realistic remaining risks (be aware of these)

- **Secrets on disk in `.env` files.** This is standard for small
  self-hosted apps, but it means anyone with filesystem access to a bot
  or the backend host can read the live secrets. Use your platform's
  secret manager (Docker secrets, systemd credentials, a cloud secrets
  store) for anything beyond local/hobby use.
- **The LLM "humanize" feature** (`ANTHROPIC_API_KEY`) sends command
  context to Anthropic's API when enabled. Leave `USE_LLM_RESPONSES=false`
  if you don't want that.
- **This is a monitoring/automation demo system, not a life-safety
  system.** Don't wire it to anything where a bug or outage could cause
  physical harm without independent hardware interlocks.

## Generating secrets

```bash
npm run setup      # first-time setup: creates .env files + unique secrets
# or, to regenerate/print a fresh set at any time:
node scripts/generate-secrets.js
```
