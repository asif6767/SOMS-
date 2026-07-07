// Copies .env.example to .env per service, then generates strong random
// secrets (AUTH_TOKEN, SOMS_DB_KEY, SOMS_HMAC_SECRET) and syncs the shared
// ones across backend + both bots automatically. No service ever ships
// with a guessable default secret — previous versions of this script left
// AUTH_TOKEN set to a fixed "soms-dev-token" placeholder, which is exactly
// the kind of default that ends up copy-pasted into a real deployment.

import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = ["soms-backend", "soms-discord-bot", "soms-telegram-bot"];

for (const dir of targets) {
  const example = join(root, dir, ".env.example");
  const dest = join(root, dir, ".env");
  if (!existsSync(example)) continue;
  if (existsSync(dest)) {
    console.log(`[setup] ${dir}/.env already exists — leaving it alone`);
    continue;
  }
  copyFileSync(example, dest);
  console.log(`[setup] created ${dir}/.env from .env.example`);
}

function hex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function setVar(envPath, key, value) {
  if (!existsSync(envPath)) return;
  let content = readFileSync(envPath, "utf-8");
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    // Only fill it in if it's currently blank, so re-running setup never
    // silently rotates a secret someone has already deployed.
    content = content.replace(regex, (match) => (match === `${key}=` ? line : match));
  } else {
    content += `\n${line}\n`;
  }
  writeFileSync(envPath, content);
}

function readVar(envPath, key) {
  if (!existsSync(envPath)) return "";
  const content = readFileSync(envPath, "utf-8");
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

const backendEnv = join(root, "soms-backend", ".env");
const discordEnv = join(root, "soms-discord-bot", ".env");
const telegramEnv = join(root, "soms-telegram-bot", ".env");

// Generate backend-only secrets if blank.
if (!readVar(backendEnv, "AUTH_TOKEN")) setVar(backendEnv, "AUTH_TOKEN", hex(32));
if (!readVar(backendEnv, "SOMS_DB_KEY")) setVar(backendEnv, "SOMS_DB_KEY", hex(32));
if (!readVar(backendEnv, "SOMS_HMAC_SECRET")) setVar(backendEnv, "SOMS_HMAC_SECRET", hex(32));

// Sync the shared secrets (auth token + HMAC secret) into both bots so
// they match the backend out of the box.
const authToken = readVar(backendEnv, "AUTH_TOKEN");
const hmacSecret = readVar(backendEnv, "SOMS_HMAC_SECRET");
for (const botEnv of [discordEnv, telegramEnv]) {
  if (!readVar(botEnv, "SOMS_AUTH_TOKEN")) setVar(botEnv, "SOMS_AUTH_TOKEN", authToken);
  if (!readVar(botEnv, "SOMS_HMAC_SECRET")) setVar(botEnv, "SOMS_HMAC_SECRET", hmacSecret);
}

console.log("\n[setup] Done. Backend/.env now has a unique AUTH_TOKEN, SOMS_DB_KEY, and SOMS_HMAC_SECRET.");
console.log("[setup] Both bots' .env files were synced with the matching AUTH_TOKEN/SOMS_HMAC_SECRET.");
console.log("[setup] Still needs manual setup: DISCORD_TOKEN + ALERTS_CHANNEL_ID, TELEGRAM_BOT_TOKEN + ALERTS_CHAT_ID.");
console.log("[setup] Back up soms-backend/.env's SOMS_DB_KEY somewhere safe — losing it makes the encrypted database unrecoverable.");
