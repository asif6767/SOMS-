// The one place the bot talks to backend

import { signRequest } from "./security.js";

const API_BASE = process.env.SOMS_API_BASE || "http://localhost:4000/api/v1";
const AUTH_TOKEN = process.env.SOMS_AUTH_TOKEN || "";
const API_PATH_PREFIX = new URL(API_BASE).pathname; // e.g. "/api/v1", must match req.originalUrl server-side

function authHeaders(method, path, rawBody) {
  const headers = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  const signature = signRequest(method, `${API_PATH_PREFIX}${path}`, rawBody);
  if (signature) headers["X-Soms-Signature"] = signature;
  return headers;
}

async function get(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: authHeaders("GET", path, ""),
  });
  if (!res.ok) {
    throw new Error(`SOMS backend ${path} -> HTTP ${res.status}`);
  }
  return res.json();
}

// write() backs every control command
async function write(method, path, body) {
  const rawBody = body !== undefined ? JSON.stringify(body) : "";
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(method, path, rawBody),
    },
    body: rawBody || undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `SOMS backend ${path} -> HTTP ${res.status}`);
  }
  return data;
}

export async function getSnapshot() {
  return get("/snapshot");
}

export async function getRoom(roomId) {
  return get(`/rooms/${roomId}`);
}

export async function getPower() {
  return get("/power");
}

export async function getAlerts() {
  return get("/alerts");
}

export async function getCost() {
  return get("/cost");
}

// Rough today's-estimated-usage figure for !usage
export async function getEstimatedKwhToday() {
  const cost = await getCost();
  const kwh = cost.ratePerKwh > 0 ? cost.total / cost.ratePerKwh : 0;
  return kwh;
}

// ---------------- control / write actions ----------------

export async function getSettings() {
  return get("/settings");
}

export async function patchSettings(patch) {
  return write("PATCH", "/settings", patch);
}

export async function getSystemPower() {
  return get("/system");
}

export async function setSystemPower(enabled, actor) {
  return write("POST", "/system/power", { enabled, actor });
}

export async function setDevice(deviceId, status) {
  return write("PATCH", `/devices/${encodeURIComponent(deviceId)}`, { status });
}

export async function setRoomAuto(roomId, enabled) {
  return write("PATCH", `/rooms/${encodeURIComponent(roomId)}/auto`, { enabled });
}

export async function listRooms() {
  return get("/rooms");
}

export async function addRoom({ name, fans, lights, acs, computers }) {
  return write("POST", "/rooms", { name, fans, lights, acs, computers });
}

export async function removeRoom(roomId) {
  return write("DELETE", `/rooms/${encodeURIComponent(roomId)}`, undefined);
}

export async function getWeather() {
  return get("/weather");
}

export async function setLocation(lat, lon, label) {
  return write("PATCH", "/settings", { location: { lat, lon, label } });
}

export async function setHowToUse({ youtubeUrl, guidelines }) {
  return write("PATCH", "/settings", { howToUse: { youtubeUrl, guidelines } });
}
