// Request signing for bot -> backend traffic. Mirrors soms-backend's
// security/auth.js verification exactly: sign `${method}\n${path}\n${body}`
// with the shared SOMS_HMAC_SECRET. Optional — leave SOMS_HMAC_SECRET blank
// to skip signing (bearer token alone still applies).

import crypto from "node:crypto";

const HMAC_SECRET = process.env.SOMS_HMAC_SECRET || "";

export function signRequest(method, path, body) {
  if (!HMAC_SECRET) return null;
  const payload = `${method}\n${path}\n${body || ""}`;
  return crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
}
