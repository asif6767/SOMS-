#!/usr/bin/env node
// Generates strong, random secrets for SOMS and prints them ready to paste
// into the relevant .env files. Never reuses or derives from anything
// predictable — every value here is crypto.randomBytes output.

import crypto from "node:crypto";

function hex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

console.log("# Paste these into soms-backend/.env, soms-discord-bot/.env, and soms-telegram-bot/.env");
console.log("# (SOMS_AUTH_TOKEN and SOMS_HMAC_SECRET must be IDENTICAL across all three services.)\n");

console.log("# --- soms-backend/.env ---");
console.log(`AUTH_TOKEN=${hex(32)}`);
console.log(`SOMS_DB_KEY=${hex(32)}          # 32-byte AES-256 key, keep this secret and back it up separately`);
console.log(`SOMS_HMAC_SECRET=${hex(32)}      # shared with both bots for request signing\n`);

console.log("# --- soms-discord-bot/.env and soms-telegram-bot/.env (use the SAME values as above) ---");
console.log("SOMS_AUTH_TOKEN=<same as AUTH_TOKEN above>");
console.log("SOMS_HMAC_SECRET=<same as SOMS_HMAC_SECRET above>");
