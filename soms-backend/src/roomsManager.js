// Backend logic for Settings > Manage Rooms

import { ROOMS } from "./schema.js";
import { state, history, makeDevices } from "./state.js";
import { db } from "./db.js";
import { broadcast, _setListRoomsSummary } from "./ws/broadcaster.js";
import { buildSnapshot } from "./snapshot.js";

function slugify(name) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  let id = base || `room-${Date.now()}`;
  let n = 2;
  while (ROOMS.some((r) => r.id === id)) {
    id = `${base}-${n++}`;
  }
  return id;
}

function persistRoomsToDb() {
  db.set({ rooms: ROOMS });
}

function logAudit(entry) {
  db.append("roomAuditLog", { id: `audit-${Date.now()}-${Math.round(Math.random() * 9999)}`, at: new Date().toISOString(), ...entry });
}

export function listRoomsSummary() {
  return ROOMS.map((r) => {
    const devices = state.devices.filter((d) => d.room === r.id);
    const counts = { fan: 0, light: 0, ac: 0, computer: 0 };
    for (const d of devices) if (counts[d.type] !== undefined) counts[d.type]++;
    return {
      id: r.id,
      name: r.name,
      counts,
      deviceCount: devices.length,
      autoControlEnabled: state.automation[r.id]?.autoControlEnabled ?? true,
    };
  });
}
_setListRoomsSummary(listRoomsSummary);

export function getRoomAuditLog() {
  return db.get().roomAuditLog.slice(-200).reverse();
}

export class RoomValidationError extends Error {}

export function addRoom({ name, fans = 0, lights = 0, acs = 0, computers = 0 }) {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new RoomValidationError("Room name is required.");
  }
  const counts = {
    fan: clampCount(fans),
    light: clampCount(lights),
    ac: clampCount(acs),
    computer: clampCount(computers),
  };
  if (counts.fan + counts.light + counts.ac + counts.computer === 0) {
    throw new RoomValidationError("A room needs at least one device (fan, light, AC, or computer).");
  }

  const id = slugify(name);
  const room = { id, name: name.trim(), counts, addedAt: new Date().toISOString() };
  ROOMS.push(room);

  const devices = makeDevices(id, counts);
  state.devices.push(...devices);
  for (const d of devices) {
    history.deviceIntervals[d.id] = d.status === "off" ? [] : [{ start: d.lastChanged, end: null }];
  }

  state.environment[id] = {
    room: id,
    temperatureC: 23 + Math.random() * 3,
    humidityPct: 45 + Math.random() * 10,
    co2Ppm: 550 + Math.random() * 200,
    o2Pct: 20.6 + Math.random() * 0.3,
    lastReadAt: new Date().toISOString(),
  };
  state.occupancy[id] = 0;
  history.occupancySnapshots[id] = [{ t: Date.now(), count: 0 }];
  state.automation[id] = { autoControlEnabled: true, lastRecommendation: "No recommendation yet", lastAction: null };
  state.smokeLevel[id] = Math.random() * 8;
  state.fireAlert[id] = false;
  state.hardware[id] = { mode: "simulated", deviceId: null, lastSeenAt: null, staleSince: null, uptimeMs: null, liveWattage: null };

  persistRoomsToDb();
  logAudit({ action: "add", roomId: id, roomName: room.name, detail: `Added with ${devices.length} devices (fans:${counts.fan}, lights:${counts.light}, ac:${counts.ac}, computers:${counts.computer})` });

  broadcast("state:snapshot", { ...buildSnapshot(), rooms: ROOMS, roomsSummary: listRoomsSummary(), avatar: db.get().avatar || null });
  return room;
}

export function removeRoom(id) {
  const idx = ROOMS.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = ROOMS.splice(idx, 1);

  const removedDeviceIds = state.devices.filter((d) => d.room === id).map((d) => d.id);
  state.devices = state.devices.filter((d) => d.room !== id);
  state.pcs = state.pcs.filter((p) => p.room !== id);
  for (const did of removedDeviceIds) delete history.deviceIntervals[did];
  delete state.environment[id];
  delete state.occupancy[id];
  delete history.occupancySnapshots[id];
  delete state.automation[id];
  delete state.smokeLevel[id];
  delete state.fireAlert[id];
  delete state.hardware[id];
  state.alerts = state.alerts.filter((a) => a.roomId !== id);

  persistRoomsToDb();
  logAudit({ action: "remove", roomId: id, roomName: removed.name, detail: `Removed room with ${removedDeviceIds.length} devices. Historical cost/audit data for this room is preserved.` });

  broadcast("state:snapshot", { ...buildSnapshot(), rooms: ROOMS, roomsSummary: listRoomsSummary(), avatar: db.get().avatar || null });
  return removed;
}

export function setRoomAuto(id, enabled) {
  if (!state.automation[id]) return null;
  state.automation[id].autoControlEnabled = enabled;
  broadcast("state:diff", { automation: { [id]: state.automation[id] } });
  return state.automation[id];
}

function clampCount(n) {
  const v = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(20, v)); // sane upper bound per device type per room
}
