import { ROOMS } from "./schema.js";
import { state, stateLock, recordDeviceChange, recordOccupancy } from "./state.js";
import { runAlertChecks, isWithinOfficeHours } from "./rules/alerts.js";
import { runAutoControl } from "./rules/autoControl.js";
import { buildSnapshot } from "./snapshot.js";
import { broadcastDiff } from "./ws/broadcaster.js";
import { isRoomSimulated } from "./hardware.js";
import { maybeRecordCostSnapshot } from "./costHistory.js";

// Registration point for tick-handler functions
const tickHandlers = [];
export function registerTickHandler(fn) {
  tickHandlers.push(fn);
}

function setDeviceStatus(deviceId, status) {
  const d = state.devices.find((x) => x.id === deviceId);
  if (!d || d.status === status) return;
  d.status = status;
  d.lastChanged = new Date().toISOString();
  recordDeviceChange(d);
}

// ---- device on/off random-walk ----
registerTickHandler(function deviceRandomWalk() {
  for (const d of state.devices) {
    // Live ESP32 room owns its own state
    if (!isRoomSimulated(d.room)) continue;
    if (Math.random() < 0.03) {
      setDeviceStatus(d.id, d.status === "on" ? "off" : "on");
    }
  }
});

// ---- PC random-walk (Work Room 1 & 2) ----
registerTickHandler(function pcRandomWalk() {
  for (const pc of state.pcs) {
    if (Math.random() < 0.04) {
      pc.on = !pc.on;
      pc.lastActivityAt = new Date().toISOString();
    }
  }
});

// ---- occupancy simulation ----
registerTickHandler(function occupancySimulation() {
  const officeHours = isWithinOfficeHours();
  for (const room of ROOMS) {
    if (!isRoomSimulated(room.id)) continue; // PIR telemetry owns this room's occupancy
    let occ = state.occupancy[room.id];
    if (officeHours) {
      if (Math.random() < 0.2) occ = Math.max(0, Math.min(8, occ + (Math.random() > 0.5 ? 1 : -1)));
    } else {
      // near-zero outside office hours
      if (occ > 0 && Math.random() < 0.5) occ -= 1;
    }
    state.occupancy[room.id] = occ;
    recordOccupancy(room.id, occ);
  }
});

// ---- environment simulation (temp/humidity/CO2/O2), nudged by occupancy ----
registerTickHandler(function environmentSimulation() {
  for (const room of ROOMS) {
    if (!isRoomSimulated(room.id)) continue; // DHT22/MQ-135 telemetry owns this room's readings
    const env = state.environment[room.id];
    const occ = state.occupancy[room.id];
    env.temperatureC = clamp(env.temperatureC + (Math.random() - 0.5) * 0.4, 20, 30);
    env.humidityPct = clamp(env.humidityPct + (Math.random() - 0.5) * 1.2, 30, 70);
    env.co2Ppm = clamp(env.co2Ppm + occ * 3 + (Math.random() - 0.6) * 20, 400, 1200);
    env.o2Pct = clamp(env.o2Pct - occ * 0.005 + (Math.random() - 0.5) * 0.02, 19, 21);
    env.lastReadAt = new Date().toISOString();
  }
});

// ---- fire/smoke simulation ----
registerTickHandler(function fireSmokeSimulation() {
  for (const room of ROOMS) {
    if (!isRoomSimulated(room.id)) continue; // flame-sensor telemetry owns this room's smoke level
    let smoke = state.smokeLevel[room.id];
    // rare spike, tunable
    if (Math.random() < 0.01) {
      smoke = Math.min(100, smoke + 40 + Math.random() * 40);
    } else {
      smoke = Math.max(0, smoke + (Math.random() - 0.6) * 4);
    }
    state.smokeLevel[room.id] = smoke;
  }
});

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

let intervalHandle = null;

export function startSimulator({ intervalMs = 6000 } = {}) {
  if (intervalHandle) return;

  intervalHandle = setInterval(async () => {
    await stateLock.withLock(async () => {
      const prevSnapshot = buildSnapshot();

      for (const handler of tickHandlers) handler();
      runAutoControl(setDeviceStatus);
      runAlertChecks();
      maybeRecordCostSnapshot();

      const nextSnapshot = buildSnapshot();
      broadcastDiff(prevSnapshot, nextSnapshot);
    });
  }, intervalMs);

  console.log(`[simulator] tick loop started, interval=${intervalMs}ms`);
}

export function stopSimulator() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

export { setDeviceStatus };
