# SOMS — Smart Office Management System

SOMS is a real-time platform for monitoring, automating, and remotely controlling a smart office — from environmental sensors and device control to cost tracking and chat-based operations via Discord and Telegram.

It combines a live backend, a web dashboard, ESP32 hardware-node firmware, and two chat bots into a single connected system, backed by an encrypted, tamper-evident data store.

---

## Table of Contents

- [What SOMS Does](#what-soms-does)
- [Features](#features)
- [Security](#security)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [License](#license)

---

## What SOMS Does

SOMS turns a physical office into a monitored, controllable system:

- **Sensors and hardware nodes** (ESP32-based) report temperature, humidity, CO₂, O₂, and occupancy per room, and expose devices (fans, lights, AC units, computers) for remote control.
- **The backend** ingests that telemetry in real time, maintains live state for every room and device, evaluates automation rules, tracks energy cost, and raises alerts when readings cross safety or efficiency thresholds.
- **The dashboard** gives a live, room-by-room view of the office: environment readings, device states, occupancy, power draw, and cost — updated over a WebSocket feed as it happens.
- **The Discord and Telegram bots** let authorized users check status and control devices from chat, and receive proactive alerts (e.g. a room left powered on with zero occupancy, an environmental threshold breach) without opening the dashboard.

In short: SOMS is the control plane for a smart office — sensing, deciding, acting, and notifying, all in one system.

---

## Features

### Monitoring
- Live environment readings per room — temperature, humidity, CO₂, O₂
- Real-time occupancy tracking
- Live power draw and running cost, computed from per-device wattage baselines and a configurable kWh rate
- Historical cost snapshots with export (PDF)
- A live system-wide snapshot endpoint and WebSocket feed for dashboards

### Automation & Alerts
- Explainable, rule-based auto-control engine (e.g. power down a room after a sustained zero-occupancy period, respond to outdoor weather conditions)
- Per-room automation toggles — every room can be automated independently, or left to manual control
- A pluggable alert-check registry for safety and energy-efficiency conditions (e.g. a device left on far longer than expected, environmental readings outside a safe range)
- An audit log for room configuration changes

### Control
- Per-device control (on/off) via REST API, dashboard, or chat bots
- Room management — add, remove, and configure rooms and their devices
- System-wide power control
- Configurable settings (automation rules, thresholds, kWh rate) with live effect

### Chat Bots (Discord & Telegram)
- Query live status and control devices directly from chat
- Role/allowlist-gated control commands (Discord: server role or explicit owner allowlist for DMs; Telegram: admin chat-ID allowlist)
- Proactive alert delivery to a configured channel/chat
- Optional LLM-humanized responses for more natural bot replies (opt-in, uses the Anthropic API)

### Hardware Integration
- ESP32 firmware for physical sensor/device nodes
- A Wokwi simulation profile for testing hardware behavior without physical devices
- A telemetry ingestion endpoint and per-room command queue for hardware nodes to poll

### Dashboard
- Live-updating web dashboard fed by the WebSocket broadcaster
- Customizable branding (uploadable avatar/logo)
- Weather integration for location-aware automation and display

---

## Security

SOMS is built with the assumption that it will be reachable by bots, dashboards, and hardware nodes outside a single trusted process — so the API, the data store, and the chat integrations are all hardened accordingly. Full detail, including honest limitations, lives in [`SECURITY.md`](./SECURITY.md); the summary:

| Layer | Protection |
|---|---|
| **Data at rest** | The entire database (rooms, settings, cost history, audit log) is encrypted with **AES-256-GCM** before it touches disk. Every write uses a fresh IV, and the authentication tag makes any tampering or corruption fail loudly instead of silently loading bad data. |
| **API authentication** | Bearer-token auth on every route, compared with `crypto.timingSafeEqual` so response timing can't leak how much of the token an attacker guessed correctly. |
| **Request integrity** | Optional HMAC-SHA256 request signing (`SOMS_HMAC_SECRET`) between the bots and the backend, binding each request to its exact method, path, and body — a captured request can't simply be replayed elsewhere. |
| **Brute-force protection** | Per-IP lockout after repeated failed auth attempts, enforced on both the REST API and the WebSocket upgrade path. |
| **Bot access control** | Discord control commands require a server role (or an explicit owner allowlist for DMs — DMs are *not* trusted by default); Telegram control commands require the sender's chat ID to be on an admin allowlist. Both bots rate-limit commands per user. |
| **Transport** | Designed to run behind a TLS-terminating reverse proxy (recommended), or with native TLS via `TLS_KEY_FILE`/`TLS_CERT_FILE` for simpler deployments. Plain HTTP/WS is not intended for public exposure. |
| **Secrets** | Every secret (`AUTH_TOKEN`, `SOMS_DB_KEY`, `SOMS_HMAC_SECRET`) is generated fresh per install — there are no working default values, and Docker Compose will refuse to start if any are missing. |

No system is "unbreakable," and SOMS doesn't claim to be — the goal is to make the real, practical attack surface (network access, brute force, replay, careless defaults) as small as it can reasonably be, and to be transparent about where the remaining risk sits (chiefly: protecting the secrets themselves). See [`SECURITY.md`](./SECURITY.md) for the full model and reasoning.

---

## Architecture

```
┌─────────────────┐        ┌──────────────────────┐        ┌─────────────────┐
│  ESP32 hardware  │──HTTP─▶│                      │◀──HTTP─│   Web Dashboard │
│  nodes (sensors/ │        │                      │        │  (soms-frontend)│
│  devices)        │        │     soms-backend     │──WS───▶│  live updates   │
└─────────────────┘        │  Express REST API    │        └─────────────────┘
                            │  WebSocket broadcaster│
┌─────────────────┐        │  Automation & alerts  │        ┌─────────────────┐
│  Discord bot     │◀─HTTP─▶│  Encrypted datastore  │◀─HTTP─▶│  Telegram bot   │
│  (control/alerts)│        │  (AES-256-GCM)        │        │ (control/alerts)│
└─────────────────┘        └──────────────────────┘        └─────────────────┘
```

**Data flow:** hardware nodes and the simulator feed live readings into the backend's in-memory state → the automation engine and alert checks evaluate that state on every tick → changes broadcast to all connected dashboard clients over WebSocket → REST endpoints (used by the dashboard and both bots) read and mutate the same state → changes are persisted to the encrypted datastore with debounced, non-blocking writes.

### Tech stack

| Component | Technology |
|---|---|
| Backend API | Node.js, Express, `ws` (WebSocket) |
| Data store | Encrypted flat-file JSON store (AES-256-GCM), no external DB dependency |
| Security | `helmet`, `express-rate-limit`, `compression`, Node's built-in `crypto` |
| Dashboard | Static frontend, served independently, wired to the backend over REST + WebSocket |
| Discord bot | `discord.js` |
| Telegram bot | `node-telegram-bot-api` |
| Hardware | ESP32 firmware (C++), Wokwi simulation |
| Deployment | Docker Compose (backend, frontend, both bots) |

### Repository layout at a glance

- `soms-backend/` — the API, simulator, automation/alert engine, WebSocket broadcaster, and encrypted datastore
- `soms-discord-bot/` / `soms-telegram-bot/` — chat control and notifications
- `soms-frontend-wired/` — the built dashboard
- `hardware/` — ESP32 firmware and its Wokwi simulation
- `diagrams/` — system architecture diagram
- `scripts/` — environment setup and secret generation

(See [Project Structure](#project-structure) below for the full tree.)

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- Docker and Docker Compose (optional, for containerized deployment)
- A Discord bot token and/or a Telegram bot token, if you want the chat integrations

### Local development

```bash
git clone <this-repository>
cd SOMS-v2
npm install
npm run setup          # creates .env files for every service with unique, generated secrets
```

Fill in the bot tokens this can't generate for you:

- `soms-discord-bot/.env` → `DISCORD_TOKEN`, `ALERTS_CHANNEL_ID`
- `soms-telegram-bot/.env` → `TELEGRAM_BOT_TOKEN`, `ALERTS_CHAT_ID`

Then run everything together:

```bash
npm run dev:all        # backend + dashboard + Discord bot + Telegram bot
```

Or run pieces individually:

```bash
npm run dev:backend
npm run dev:frontend
npm run dev:bot         # Discord
npm run dev:telegram
```

The backend listens on `http://localhost:4000` by default (REST under `/api/v1`, WebSocket at `/ws/live`), and the dashboard on `http://localhost:8080`.

### Docker deployment

```bash
cp .env.example .env
node scripts/generate-secrets.js   # paste AUTH_TOKEN / SOMS_DB_KEY / SOMS_HMAC_SECRET into .env
docker compose up -d --build
```

Docker Compose will refuse to start if `AUTH_TOKEN`, `SOMS_DB_KEY`, `SOMS_HMAC_SECRET`, or `CORS_ORIGIN` are missing from `.env` — this is intentional, so the stack can never come up silently unauthenticated.

### Regenerating secrets at any time

```bash
npm run gen:secrets
```

> **Back up `SOMS_DB_KEY` somewhere safe.** It's the only thing standing between the encrypted datastore and unreadable noise — losing it means losing the data.

---

## Project Structure

```
SOMS-v2/
├── soms-backend/
│   └── src/
│       ├── security/       # crypto.js (AES-256-GCM, HMAC), auth.js (auth middleware)
│       ├── routes/         # REST route handlers
│       ├── rules/          # automation + alerting logic
│       ├── ws/             # WebSocket broadcaster
│       ├── db.js           # encrypted-at-rest datastore
│       └── server.js       # application entrypoint
├── soms-discord-bot/        # Discord control/notification bot
├── soms-telegram-bot/       # Telegram control/notification bot
├── soms-frontend-wired/     # built dashboard (static)
├── hardware/                # ESP32 firmware + Wokwi simulation
├── diagrams/                 # system architecture diagram
├── scripts/
│   ├── setup-env.js          # creates .env files with unique generated secrets
│   └── generate-secrets.js   # prints a fresh set of secrets on demand
├── docker-compose.yml
├── SECURITY.md               # full security model and honest limitations
└── .env.example               # root-level env for docker-compose
```

---
