// Canonical data shapes used across the backend

import { db } from "./db.js";

const DEFAULT_ROOMS = [
  { id: "drawing", name: "Drawing Room" },
  { id: "work1", name: "Work Room 1" },
  { id: "work2", name: "Work Room 2" },
];

// ROOMS is a single shared mutable array
const persisted = db.get().rooms;
export const ROOMS = Array.isArray(persisted) && persisted.length ? persisted : DEFAULT_ROOMS.slice();

// Persist boot defaults so a restart survives
if (!Array.isArray(persisted) || !persisted.length) {
  db.set({ rooms: ROOMS });
}

export const ROOM_IDS = () => ROOMS.map((r) => r.id);

export function isValidRoom(roomId) {
  return ROOMS.some((r) => r.id === roomId);
}

// Device wattage baselines for cost figures
export const WATTAGE = {
  fan: 65,
  light: 18,
  ac: 1500,
  computer: 150,
};

export const DEVICE_TYPES = ["fan", "light", "ac", "computer"];

/**
 * Device: { id, room, type, name, wattage, status, lastChanged }
 * Room: { id, name, devices, environment, occupancyCount, pcs }
 * EnvironmentReading: { room, temperatureC, humidityPct, co2Ppm, o2Pct }
 * Alert: { id, type, severity, roomId, deviceId, title, message }
 * PC: { id, room, on, lastActivityAt }
 * AdminSettings: { officeStart, officeEnd, kwhRate, thresholds, rules, location }
 * RoomAuditLog: { id, action, roomId, roomName, detail, at }
 */
