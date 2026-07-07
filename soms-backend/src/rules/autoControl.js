import { state, continuousZeroOccupancyMs } from "../state.js";
import { ROOMS } from "../schema.js";

// Explainable, rule-based automation engine

const ZERO_OCC_THRESHOLD_MS = 15 * 60 * 1000;

function devicesOfType(roomId, type) {
  return state.devices.filter((d) => d.room === roomId && d.type === type);
}

function applyTo(devices, desiredStatus, setDeviceStatus) {
  let changed = 0;
  for (const dev of devices) {
    if (dev.status !== desiredStatus) {
      setDeviceStatus(dev.id, desiredStatus);
      changed++;
    }
  }
  return changed;
}

export function runAutoControl(setDeviceStatus) {
  if (!state.settings.rules.autoControl) return;

  const outdoor = state.weather; // may be null if the user hasn't saved a location yet

  for (const room of ROOMS) {
    const env = state.environment[room.id];
    const occupancy = state.occupancy[room.id];
    const auto = state.automation[room.id];
    if (!auto) continue;

    const unoccupiedLong = occupancy === 0 && continuousZeroOccupancyMs(room.id) > ZERO_OCC_THRESHOLD_MS;
    const notes = [];
    const actions = []; // { type, status }

    // Lights: on when occupied, off when empty
    const lights = devicesOfType(room.id, "light");
    if (lights.length) {
      if (unoccupiedLong) {
        actions.push({ type: "light", status: "off" });
        notes.push("lights OFF (unoccupied 15min+)");
      } else if (occupancy > 0) {
        actions.push({ type: "light", status: "on" });
        notes.push(`lights ON (${occupancy} occupant${occupancy === 1 ? "" : "s"})`);
      }
    }

    // Fans / AC: pick cheaper cooling first
    const fans = devicesOfType(room.id, "fan");
    const acs = devicesOfType(room.id, "ac");
    const outdoorHot = outdoor && typeof outdoor.temperatureC === "number" ? outdoor.temperatureC > 30 : null;
    const outdoorMild = outdoor && typeof outdoor.temperatureC === "number" ? outdoor.temperatureC <= 26 : null;

    if (unoccupiedLong) {
      if (fans.length) actions.push({ type: "fan", status: "off" });
      if (acs.length) actions.push({ type: "ac", status: "off" });
      notes.push("climate OFF (unoccupied 15min+)");
    } else if (occupancy > 0 && env.temperatureC > 27) {
      if (acs.length && (outdoorHot || outdoorHot === null)) {
        actions.push({ type: "ac", status: "on" });
        actions.push({ type: "fan", status: "on" });
        notes.push(`AC + fans ON (indoor ${env.temperatureC.toFixed(1)}°C, occupied${outdoorHot ? `, outdoor ${outdoor.temperatureC.toFixed(1)}°C` : ""})`);
      } else if (outdoorMild && acs.length) {
        // Hot indoors, mild outside: prefer fans
        actions.push({ type: "fan", status: "on" });
        actions.push({ type: "ac", status: "off" });
        notes.push(`fans ON, AC held OFF — mild outdoor air (${outdoor.temperatureC.toFixed(1)}°C) makes AC unnecessary`);
      } else {
        actions.push({ type: "fan", status: "on" });
        notes.push(`fans ON (indoor ${env.temperatureC.toFixed(1)}°C, occupied)`);
      }
    } else if (env.temperatureC < 22) {
      if (fans.length) actions.push({ type: "fan", status: "off" });
      if (acs.length) actions.push({ type: "ac", status: "off" });
      notes.push(`climate OFF (indoor ${env.temperatureC.toFixed(1)}°C is already cool)`);
    }

    // Computers: auto-off only, never auto-on
    const computers = devicesOfType(room.id, "computer");
    if (computers.length && unoccupiedLong) {
      actions.push({ type: "computer", status: "off" });
      notes.push("idle computers OFF (unoccupied 15min+)");
    }

    const recommendation = notes.length
      ? `${room.name}: ${notes.join("; ")}`
      : `${room.name}: conditions nominal — no change recommended`;
    auto.lastRecommendation = recommendation;

    if (auto.autoControlEnabled && actions.length) {
      let changed = 0;
      for (const { type, status } of actions) {
        changed += applyTo(devicesOfType(room.id, type), status, setDeviceStatus);
      }
      if (changed) {
        auto.lastAction = `Applied ${changed} change${changed === 1 ? "" : "s"} at ${new Date().toLocaleTimeString()}`;
      }
    }
  }
}
