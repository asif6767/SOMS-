// systemControl.js — master ON/OFF for the whole simulated

import { state, stateLock } from "./state.js";
import { setDeviceStatus } from "./simulator.js";
import { broadcast } from "./ws/broadcaster.js";
import { db } from "./db.js";

export async function setSystemPower(enabled, { actor = "system" } = {}) {
  await stateLock.withLock(async () => {
    state.settings.systemEnabled = enabled;
    db.set({ settings: state.settings });

    if (!enabled) {
      // Power everything down and drop out of auto-control
      for (const device of state.devices) {
        if (device.status === "on") {
          setDeviceStatus(device.id, "off");
        }
      }
      for (const roomId of Object.keys(state.automation)) {
        state.automation[roomId].autoControlEnabled = false;
      }
    }
  });

  broadcast("state:diff", {
    settings: { systemEnabled: state.settings.systemEnabled },
    automation: state.automation,
  });
  broadcast("system:power", { enabled, actor, at: new Date().toISOString() });

  return { enabled: state.settings.systemEnabled };
}

export function isSystemEnabled() {
  return state.settings.systemEnabled !== false;
}
