// SOMS security primitives: authenticated encryption at rest + request signing.
//
// Design notes (read before touching this file):
//  - AES-256-GCM gives us confidentiality AND integrity (auth tag). If the
//    ciphertext or IV is tampered with, decryption throws instead of
//    silently returning corrupted data.
//  - Keys are never hardcoded. They come from the environment, and in dev
//    a key is generated once and stored locally with restrictive
//    permissions so `npm run dev` still works out of the box.
//  - There is no such thing as an "unbreakable" system. This module raises
//    the cost of attacking data-at-rest and bot<->backend traffic to the
//    point where the realistic attack surface shifts to key management
//    (protect your .env / key files, use a secrets manager in prod, rotate
//    keys periodically) rather than the cryptography itself.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit IV recommended for GCM
const KEY_LEN = 32; // 256-bit key

/**
 * Load a 32-byte key from a hex-encoded env var, or fall back to a
 * generated key persisted to disk (dev/first-run convenience only).
 */
export function loadOrCreateKey({ envVar, fallbackFile, label }) {
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "hex");
    if (key.length !== KEY_LEN) {
      throw new Error(`${envVar} must be a 64-character hex string (32 bytes). Run "npm run gen:secrets" to create one.`);
    }
    return key;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${envVar} is not set. Refusing to auto-generate a key in production — ` +
        `set ${envVar} explicitly (see .env.example / SECURITY.md).`
    );
  }

  // Dev/local fallback: persist a generated key so restarts don't lose data.
  const dir = path.dirname(fallbackFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(fallbackFile)) {
    const key = Buffer.from(fs.readFileSync(fallbackFile, "utf-8").trim(), "hex");
    if (key.length === KEY_LEN) return key;
  }
  const key = crypto.randomBytes(KEY_LEN);
  fs.writeFileSync(fallbackFile, key.toString("hex"), { mode: 0o600 });
  console.warn(
    `[security] No ${envVar} set — generated a local dev-only ${label} key at ${fallbackFile}. ` +
      `Set ${envVar} explicitly before deploying anywhere real.`
  );
  return key;
}

/**
 * Encrypt a UTF-8 string/Buffer. Returns a single Buffer laid out as:
 * [12-byte IV][16-byte auth tag][ciphertext]
 */
export function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf-8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/**
 * Decrypt a Buffer produced by encrypt(). Throws if the data was tampered
 * with, truncated, or encrypted under a different key.
 */
export function decrypt(blob, key) {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + 16);
  const ciphertext = blob.subarray(IV_LEN + 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Constant-time string comparison (prevents timing side-channels on tokens). */
export function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf-8");
  const bufB = Buffer.from(String(b ?? ""), "utf-8");
  if (bufA.length !== bufB.length) {
    // Still do a comparison of equal-length buffers so the failure path
    // takes comparable time regardless of length mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** HMAC-SHA256 signature over a request body, used to sign bot<->backend traffic. */
export function signPayload(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifySignature(secret, payload, signature) {
  if (!signature) return false;
  const expected = signPayload(secret, payload);
  return timingSafeEqualString(expected, signature);
}
