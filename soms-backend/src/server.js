import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { router } from "./routes/index.js";
import { requireAuth } from "./security/auth.js";
import { initBroadcaster, clientCount } from "./ws/broadcaster.js";
import { startSimulator } from "./simulator.js";
import { startWeatherPolling } from "./weather.js";
import { db } from "./db.js";

const PORT = Number(process.env.PORT || 4000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const HMAC_SECRET = process.env.SOMS_HMAC_SECRET || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS || 6000);
const IS_PROD = process.env.NODE_ENV === "production";

if (IS_PROD && !AUTH_TOKEN) {
  console.error("[soms-backend] FATAL: AUTH_TOKEN must be set in production. Refusing to start unauthenticated.");
  process.exit(1);
}
if (IS_PROD && CORS_ORIGIN === "*") {
  console.error("[soms-backend] FATAL: CORS_ORIGIN=* is not allowed in production. Set explicit allowed origins.");
  process.exit(1);
}

const app = express();

// Security headers on every response (CSP tuned for the dashboard's needs).
app.use(
  helmet({
    contentSecurityPolicy: false, // the static dashboard sets its own CSP; avoid double-restricting API responses
    crossOriginResourcePolicy: { policy: "same-site" },
  })
);

// gzip/br response compression — biggest single win for perceived API speed
// on anything but tiny payloads (snapshot/rooms responses can be a few KB).
app.use(compression());

// /avatar route accepts a large base64 body
app.use(
  express.json({
    limit: "12mb",
    verify: (req, _res, buf) => {
      // stash the raw body so the optional HMAC signature check in
      // security/auth.js can verify it exactly as sent, before any parsing.
      req.rawBody = buf.toString("utf-8");
    },
  })
);

app.use(
  cors({
    origin: !CORS_ORIGIN || CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((s) => s.trim()),
  })
);

// Global rate limit — generous for normal dashboard/bot polling, but caps
// abuse or runaway clients. Auth-sensitive paths get a stricter limiter too.
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---- structured request logging (M10.A) ----
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", wsClients: clientCount(), uptimeSec: Math.round(process.uptime()) });
});

app.use("/api/v1", requireAuth(AUTH_TOKEN, { hmacSecret: HMAC_SECRET }), router);

// ---- consistent error shape for the whole API
app.use((req, res) => {
  res.status(404).json({ error: "not_found", message: `No route for ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      error: "payload_too_large",
      message: "That upload is too large. Please use an image under ~8MB.",
    });
  }
  console.error(err);
  // Never leak stack traces / internals to clients, in dev or prod.
  res.status(500).json({ error: "internal_error", message: "Something went wrong." });
});

// Optional native TLS termination for deployments that aren't behind a
// reverse proxy (nginx/Caddy/Cloudflare). If TLS_KEY_FILE/TLS_CERT_FILE are
// set, we serve HTTPS + WSS directly; otherwise plain HTTP, which is the
// right choice when a reverse proxy already terminates TLS in front of us.
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || "";
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || "";
const useTls = TLS_KEY_FILE && TLS_CERT_FILE;

const server = useTls
  ? https.createServer({ key: fs.readFileSync(TLS_KEY_FILE), cert: fs.readFileSync(TLS_CERT_FILE) }, app)
  : http.createServer(app);

initBroadcaster(server, { path: "/ws/live", authToken: AUTH_TOKEN });
startSimulator({ intervalMs: TICK_INTERVAL_MS });
startWeatherPolling();

server.listen(PORT, () => {
  const scheme = useTls ? "https/wss" : "http/ws";
  console.log(`[soms-backend] REST + WS listening on ${scheme}://localhost:${PORT}`);
  console.log(`[soms-backend] Auth: ${AUTH_TOKEN ? "enabled (bearer token required)" : "DISABLED (dev mode)"}`);
  console.log(`[soms-backend] Request signing (HMAC): ${HMAC_SECRET ? "enabled" : "disabled"}`);
  console.log(`[soms-backend] DB encryption: enabled (AES-256-GCM) — data dir: ${process.env.DATA_DIR || "./data"}`);
  if (!useTls) {
    console.log("[soms-backend] Serving plain HTTP/WS — put this behind a TLS-terminating reverse proxy in production.");
  }
});

// flush the debounced DB write on shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    db.forceFlushSync();
    process.exit(0);
  });
}
