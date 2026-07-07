import { WebSocketServer } from "ws";
import { state } from "../state.js";
import { onAlertEvent } from "../rules/alerts.js";
import { buildSnapshot } from "../snapshot.js";
import { ROOMS } from "../schema.js";
import { db } from "../db.js";
import { timingSafeEqualString } from "../security/crypto.js";

// Basic per-IP connection-attempt throttling, mirrors the REST brute-force
// lockout so the WS upgrade path can't be used to grind auth tokens either.
const CONNECT_ATTEMPTS = new Map(); // ip -> { count, windowStart }
const CONNECT_WINDOW_MS = 60_000;
const MAX_CONNECT_ATTEMPTS = 30;

function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = CONNECT_ATTEMPTS.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > CONNECT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  CONNECT_ATTEMPTS.set(ip, entry);
  return entry.count > MAX_CONNECT_ATTEMPTS;
}

let wss = null;
let listRoomsSummaryFn = null; // lazily wired to avoid a circular import with roomsManager.js
export function _setListRoomsSummary(fn) { listRoomsSummaryFn = fn; }

function fullSnapshotForNewConnection() {
  return {
    ...buildSnapshot(),
    rooms: ROOMS,
    roomsSummary: listRoomsSummaryFn ? listRoomsSummaryFn() : undefined,
    avatar: db.get().avatar || null,
  };
}

const clients = new Set();

export function initBroadcaster(server, { path = "/ws/live", authToken = "" } = {}) {
  wss = new WebSocketServer({ server, path });

  wss.on("connection", (ws, req) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    if (tooManyAttempts(ip)) {
      ws.close(4029, "too many connection attempts");
      return;
    }

    if (authToken) {
      const url = new URL(req.url, "http://localhost");
      const headerToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
      const queryToken = url.searchParams.get("token") || "";
      const token = headerToken || queryToken;
      if (!timingSafeEqualString(token, authToken)) {
        ws.close(4001, "unauthorized");
        return;
      }
    }

    clients.add(ws);
    // Send full state to a new client
    send(ws, "state:snapshot", fullSnapshotForNewConnection());

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // Relay alert events verbatim
  onAlertEvent((eventName, alert) => {
    broadcast(eventName, alert);
  });

  return wss;
}

function send(ws, event, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ event, payload, ts: new Date().toISOString() }));
}

export function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// Compute and broadcast a state diff
export function broadcastDiff(prevSnapshot, nextSnapshot) {
  const diff = { devices: [], environment: {}, occupancy: {}, pcs: [], automation: {}, hardware: {} };
  let changed = false;

  for (const d of nextSnapshot.devices) {
    const prev = prevSnapshot.devices.find((p) => p.id === d.id);
    if (!prev || prev.status !== d.status || prev.lastChanged !== d.lastChanged) {
      diff.devices.push(d);
      changed = true;
    }
  }
  for (const roomId of Object.keys(nextSnapshot.environment)) {
    const prev = prevSnapshot.environment[roomId];
    const cur = nextSnapshot.environment[roomId];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(cur)) {
      diff.environment[roomId] = cur;
      changed = true;
    }
  }
  for (const roomId of Object.keys(nextSnapshot.occupancy)) {
    if (prevSnapshot.occupancy[roomId] !== nextSnapshot.occupancy[roomId]) {
      diff.occupancy[roomId] = nextSnapshot.occupancy[roomId];
      changed = true;
    }
  }
  for (const pc of nextSnapshot.pcs) {
    const prev = prevSnapshot.pcs.find((p) => p.id === pc.id);
    if (!prev || prev.on !== pc.on || prev.lastActivityAt !== pc.lastActivityAt) {
      diff.pcs.push(pc);
      changed = true;
    }
  }
  for (const roomId of Object.keys(nextSnapshot.automation)) {
    const prev = prevSnapshot.automation[roomId];
    const cur = nextSnapshot.automation[roomId];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(cur)) {
      diff.automation[roomId] = cur;
      changed = true;
    }
  }

  for (const roomId of Object.keys(nextSnapshot.hardware || {})) {
    const prev = prevSnapshot.hardware?.[roomId];
    const cur = nextSnapshot.hardware[roomId];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(cur)) {
      diff.hardware[roomId] = cur;
      changed = true;
    }
  }

  if (changed) broadcast("state:diff", diff);
}

export function clientCount() {
  return clients.size;
}
