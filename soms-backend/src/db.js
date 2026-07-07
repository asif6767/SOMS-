// SOMS-DB: tiny embedded, file-backed JSON store — encrypted at rest.
//
// The on-disk file (soms.db.enc) is never plaintext JSON. Every write is
// AES-256-GCM encrypted with a per-file random IV and an authentication
// tag, so the file can't be silently edited or replayed without detection,
// and can't be read without SOMS_DB_KEY.

import fs from "node:fs";
import path from "node:path";
import { loadOrCreateKey, encrypt, decrypt } from "./security/crypto.js";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "soms.db.enc");
const LEGACY_PLAINTEXT_FILE = path.join(DATA_DIR, "soms.db.json"); // pre-encryption format, migrated once

const DB_KEY = loadOrCreateKey({
  envVar: "SOMS_DB_KEY",
  fallbackFile: path.join(DATA_DIR, ".db.key"),
  label: "database encryption",
});

const DEFAULT_DB = {
  version: 2,
  rooms: null, // null = "use schema.js defaults", array once the user customizes rooms
  roomAuditLog: [], // { id, action: 'add'|'remove', roomId, roomName, detail, at }
  costSnapshots: [], // { t (ms epoch), totalCost, totalKwh, kwhRate, perRoom: [{room,name,cost,kwh}], perType: [{type,cost,kwh}] }
  settings: null, // null = "use state.js defaults"; else persisted overrides
  avatar: null, // { dataUrl, mime, updatedAt } — the uploaded top-right brand image
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function migrateLegacyPlaintextIfPresent() {
  if (!fs.existsSync(LEGACY_PLAINTEXT_FILE)) return null;
  try {
    const raw = fs.readFileSync(LEGACY_PLAINTEXT_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    console.warn(
      "[db] Found a legacy unencrypted soms.db.json — migrating it into the encrypted store. " +
        "The plaintext file will be renamed to soms.db.json.migrated once this succeeds."
    );
    fs.renameSync(LEGACY_PLAINTEXT_FILE, LEGACY_PLAINTEXT_FILE + ".migrated");
    return parsed;
  } catch (err) {
    console.error("[db] failed to migrate legacy soms.db.json:", err.message);
    return null;
  }
}

function readSync() {
  ensureDataDir();

  const migrated = migrateLegacyPlaintextIfPresent();
  if (migrated) return Object.assign(structuredClone(DEFAULT_DB), migrated);

  if (!fs.existsSync(DB_FILE)) {
    const fresh = structuredClone(DEFAULT_DB);
    fs.writeFileSync(DB_FILE, encrypt(JSON.stringify(fresh), DB_KEY), { mode: 0o600 });
    return fresh;
  }
  try {
    const blob = fs.readFileSync(DB_FILE);
    const raw = decrypt(blob, DB_KEY).toString("utf-8");
    return Object.assign(structuredClone(DEFAULT_DB), JSON.parse(raw));
  } catch (err) {
    // Do NOT overwrite a corrupted/tampered file automatically — that would
    // destroy evidence and any chance of recovery. Fail loudly instead.
    console.error(
      "[db] failed to read/decrypt soms.db.enc — the file may be corrupted, tampered with, " +
        "or encrypted under a different SOMS_DB_KEY:",
      err.message
    );
    throw new Error("soms.db.enc could not be decrypted. Refusing to start with an unreadable database.");
  }
}

// Loaded once at import time
let cache = readSync();

let writeQueued = false;
let writePending = false;

function flush() {
  writeQueued = false;
  if (writePending) return; // a write is mid-flight, it'll pick up latest `cache` itself
  writePending = true;
  const tmp = DB_FILE + ".tmp";
  const blob = encrypt(JSON.stringify(cache), DB_KEY);
  fs.writeFile(tmp, blob, { mode: 0o600 }, (err) => {
    writePending = false;
    if (err) {
      console.error("[db] write failed:", err.message);
      return;
    }
    fs.rename(tmp, DB_FILE, (renameErr) => {
      if (renameErr) console.error("[db] rename failed:", renameErr.message);
    });
  });
}

function persist() {
  // debounce: collapse rapid writes into one
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(flush, 50);
}

export const db = {
  get() {
    return cache;
  },
  set(patch) {
    Object.assign(cache, patch);
    persist();
  },
  append(table, row) {
    if (!Array.isArray(cache[table])) cache[table] = [];
    cache[table].push(row);
    persist();
  },
  // Keep on-disk cost history bounded
  pruneCostSnapshots(maxAgeMs = 2 * 365 * 24 * 3600 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    cache.costSnapshots = cache.costSnapshots.filter((s) => s.t >= cutoff);
  },
  forceFlushSync() {
    // used on graceful shutdown
    try {
      fs.writeFileSync(DB_FILE, encrypt(JSON.stringify(cache), DB_KEY), { mode: 0o600 });
    } catch (err) {
      console.error("[db] sync flush failed:", err.message);
    }
  },
};
