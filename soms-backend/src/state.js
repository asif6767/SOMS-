import { ROOMS, WATTAGE } from "./schema.js";
import { db } from "./db.js";

// ---------- simple async mutex ----------
class Mutex {
  constructor() {
    this._locked = false;
    this._queue = [];
  }
  async lock() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise((resolve) => this._queue.push(resolve));
  }
  unlock() {
    const next = this._queue.shift();
    if (next) next();
    else this._locked = false;
  }
  async withLock(fn) {
    await this.lock();
    try {
      return await fn();
    } finally {
      this.unlock();
    }
  }
}

export const stateLock = new Mutex();

// Default per-room device counts, original rooms
const DEFAULT_COUNTS = { fan: 2, light: 3, ac: 0, computer: 0 };

// ---------- device factory ----------
export function makeDevices(roomId, counts = DEFAULT_COUNTS) {
  const now = new Date().toISOString();
  const c = { ...DEFAULT_COUNTS, ...counts };
  const devices = [];
  const label = { fan: "Ceiling Fan", light: "Panel Light", ac: "AC Unit", computer: "Computer" };
  const startChance = { fan: 0.45, light: 0.35, ac: 0.2, computer: 0.5 };
  for (const type of ["fan", "light", "ac", "computer"]) {
    for (let i = 1; i <= (c[type] || 0); i++) {
      devices.push({
        id: `${roomId}-${type}${i}`,
        room: roomId,
        type,
        name: `${label[type]} ${i}`,
        wattage: WATTAGE[type],
        status: Math.random() > 1 - startChance[type] ? "on" : "off",
        lastChanged: now,
      });
    }
  }
  return devices;
}

function initialCountsFor(roomId) {
  // Original 3 rooms keep their historical layout
  const room = ROOMS.find((r) => r.id === roomId);
  return room && room.counts ? room.counts : DEFAULT_COUNTS;
}

// ---------- persisted settings overlay ----------
const persistedSettings = db.get().settings;
const baseSettings = {
  officeStart: "09:00",
  officeEnd: "17:00",
  kwhRate: Number(process.env.DEFAULT_KWH_RATE || 0.14),
  co2Threshold: 1000,
  smokeThreshold: 70,
  currency: "USD",
  location: null, // { lat, lon, label } — set via PATCH /settings from the frontend's geolocation prompt
  systemEnabled: true, // master power switch — flipped via PATCH /system, the dashboard, Discord (!on/!off) or Telegram (/on /off)
  howToUse: {
    // Shown as a How-To-Used button
    youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    guidelines: "Welcome to SOMS! Watch the video above for a full walkthrough of the dashboard, then explore the Office Layout, Devices, and Automation tabs.",
  },
  rules: {
    autoControl: true,
    afterHours: true,
    fireMonitoring: true,
    pcMonitoring: true,
  },
};
const settings = persistedSettings ? { ...baseSettings, ...persistedSettings, rules: { ...baseSettings.rules, ...(persistedSettings.rules || {}) } } : baseSettings;
if (!persistedSettings) db.set({ settings });

// ---------- store ----------
export const state = {
  devices: ROOMS.flatMap((r) => makeDevices(r.id, initialCountsFor(r.id))),

  // PCs: Work Room 1 & 2 only
  pcs: [
    { id: "work1-pc-1", room: "work1", on: true, lastActivityAt: new Date(Date.now() - 1000 * 60 * 40).toISOString() },
    { id: "work1-pc-2", room: "work1", on: false, lastActivityAt: new Date(Date.now() - 1000 * 60 * 220).toISOString() },
    { id: "work2-pc-1", room: "work2", on: true, lastActivityAt: new Date(Date.now() - 1000 * 60 * 12).toISOString() },
    { id: "work2-pc-2", room: "work2", on: true, lastActivityAt: new Date(Date.now() - 1000 * 60 * 95).toISOString() },
  ],

  environment: Object.fromEntries(
    ROOMS.map((r) => [
      r.id,
      {
        room: r.id,
        temperatureC: 23 + Math.random() * 3,
        humidityPct: 45 + Math.random() * 10,
        co2Ppm: 550 + Math.random() * 200,
        o2Pct: 20.6 + Math.random() * 0.3,
        lastReadAt: new Date().toISOString(),
      },
    ])
  ),

  occupancy: Object.fromEntries(ROOMS.map((r) => [r.id, Math.floor(Math.random() * 5)])),

  alerts: [],
  nextAlertId: 1,

  settings,

  automation: Object.fromEntries(
    ROOMS.map((r) => [
      r.id,
      { autoControlEnabled: true, lastRecommendation: "No recommendation yet", lastAction: null },
    ])
  ),

  smokeLevel: Object.fromEntries(ROOMS.map((r) => [r.id, Math.random() * 8])),
  fireAlert: Object.fromEntries(ROOMS.map((r) => [r.id, false])),

  // Hardware link status, simulated until first telemetry
  hardware: Object.fromEntries(
    ROOMS.map((r) => [
      r.id,
      { mode: "simulated", deviceId: null, lastSeenAt: null, staleSince: null, uptimeMs: null, liveWattage: null },
    ])
  ),
};

// ---------- history (time-series log) ----------
export const history = {
  deviceIntervals: {}, // deviceId -> [{ start, end }]  end=null means still ongoing
  occupancySnapshots: {}, // roomId -> [{ t, count }]
};

for (const d of state.devices) {
  history.deviceIntervals[d.id] = [
    { start: d.lastChanged, end: d.status === "on" ? null : new Date().toISOString() },
  ];
  if (d.status === "off") {
    // no ongoing interval
    history.deviceIntervals[d.id] = [];
  }
}
for (const r of ROOMS) history.occupancySnapshots[r.id] = [{ t: Date.now(), count: state.occupancy[r.id] }];

export function recordDeviceChange(device) {
  const intervals = history.deviceIntervals[device.id] || (history.deviceIntervals[device.id] = []);
  const last = intervals[intervals.length - 1];
  if (device.status === "on") {
    if (!last || last.end !== null) intervals.push({ start: device.lastChanged, end: null });
  } else {
    if (last && last.end === null) last.end = device.lastChanged;
  }
  // keep history bounded, drop old intervals
  const cutoff = Date.now() - 48 * 3600 * 1000;
  history.deviceIntervals[device.id] = intervals.filter(
    (iv) => iv.end === null || new Date(iv.end).getTime() > cutoff
  );
}

export function recordOccupancy(roomId, count) {
  const snaps = history.occupancySnapshots[roomId] || (history.occupancySnapshots[roomId] = []);
  snaps.push({ t: Date.now(), count });
  const cutoff = Date.now() - 6 * 3600 * 1000;
  history.occupancySnapshots[roomId] = snaps.filter((s) => s.t > cutoff).slice(-2000);
}

// How long a device has stayed on
export function continuousOnDurationMs(deviceId) {
  const intervals = history.deviceIntervals[deviceId] || [];
  const ongoing = intervals.find((iv) => iv.end === null);
  if (!ongoing) return 0;
  return Date.now() - new Date(ongoing.start).getTime();
}

// How long a room has stayed empty
export function continuousZeroOccupancyMs(roomId) {
  const snaps = history.occupancySnapshots[roomId] || [];
  let ms = 0;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].count === 0) {
      ms = Date.now() - snaps[i].t;
    } else {
      break;
    }
  }
  // walk back to find the actual start
  let start = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].count === 0) start = snaps[i].t;
    else break;
  }
  return start ? Date.now() - start : 0;
}

// Sum device on-time hours since a point
export function onTimeHoursSince(deviceId, sinceMs) {
  const since = Date.now() - sinceMs;
  const intervals = history.deviceIntervals[deviceId] || [];
  let ms = 0;
  for (const iv of intervals) {
    const start = Math.max(new Date(iv.start).getTime(), since);
    const end = iv.end ? new Date(iv.end).getTime() : Date.now();
    if (end > start) ms += end - start;
  }
  return ms / 3600000;
}
