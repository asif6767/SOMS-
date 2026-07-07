// Bearer-token + HMAC request-signing auth for every API route.
//
// Two independent layers, both required when configured:
//   1. Bearer token   — same shared secret model as before, but compared in
//      constant time so response timing can't leak how much of the token
//      matched.
//   2. HMAC signature — the caller (dashboard/bot) signs `${method}\n${path}\n${body}`
//      with a shared secret (SOMS_HMAC_SECRET) and sends it as
//      X-Soms-Signature. This defeats token-only replay from anyone who
//      merely sniffs a request (e.g. from logs or a misconfigured proxy),
//      since the signature is tied to that exact request body and path.
//      It's optional — set SOMS_HMAC_SECRET to turn it on for both the
//      backend and the bots.
//
// Also implements a simple in-memory brute-force lockout: after too many
// bad auth attempts from one IP in a short window, that IP is temporarily
// blocked, independent of the global rate limiter.

import { timingSafeEqualString, verifySignature } from "./crypto.js";

const FAILURES = new Map(); // ip -> { count, firstAt, blockedUntil }
const WINDOW_MS = 60_000;
const MAX_FAILURES = 10;
const BLOCK_MS = 5 * 60_000;

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = FAILURES.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - entry.firstAt > WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.blockedUntil = now + BLOCK_MS;
  }
  FAILURES.set(ip, entry);
}

function isBlocked(ip) {
  const entry = FAILURES.get(ip);
  if (!entry) return false;
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) return true;
  if (entry.blockedUntil && entry.blockedUntil <= Date.now()) FAILURES.delete(ip);
  return false;
}

export function requireAuth(authToken, { hmacSecret = "" } = {}) {
  return function (req, res, next) {
    const ip = clientIp(req);

    if (isBlocked(ip)) {
      return res.status(429).json({
        error: "too_many_attempts",
        message: "Too many failed auth attempts from this address. Try again later.",
      });
    }

    if (authToken) {
      const header = req.headers["authorization"] || "";
      const token = header.replace(/^Bearer\s+/i, "");
      if (!timingSafeEqualString(token, authToken)) {
        recordFailure(ip);
        return res.status(401).json({ error: "unauthorized", message: "Missing or invalid bearer token." });
      }
    }

    if (hmacSecret) {
      const signature = req.headers["x-soms-signature"];
      const rawBody = req.rawBody || "";
      const signed = `${req.method}\n${req.originalUrl}\n${rawBody}`;
      if (!verifySignature(hmacSecret, signed, signature)) {
        recordFailure(ip);
        return res.status(401).json({ error: "bad_signature", message: "Missing or invalid request signature." });
      }
    }

    next();
  };
}
