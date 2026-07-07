import { state, history, continuousOnDurationMs } from "../state.js";
import { ROOMS } from "../schema.js";

// Registry every safety/energy check plugs into

const checks = [];
let listeners = []; // (eventName, alert) => void

export function onAlertEvent(fn) {
  listeners.push(fn);
}

function emit(eventName, alert) {
  for (const fn of listeners) fn(eventName, alert);
}

export function registerAlertCheck(fn) {
  checks.push(fn);
}

function findActiveAlert(predicate) {
  return state.alerts.find((a) => !a.resolvedAt && predicate(a));
}

export function createAlert({ type, severity, roomId, deviceId = null, title, message }) {
  const alert = {
    id: state.nextAlertId++,
    type,
    severity,
    roomId,
    deviceId,
    title,
    message,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
  state.alerts.unshift(alert);
  emit("alert:new", alert);
  return alert;
}

export function resolveAlert(alert) {
  alert.resolvedAt = new Date().toISOString();
  emit("alert:resolved", alert);
}

function isWithinOfficeHours(now = new Date()) {
  const [sh, sm] = state.settings.officeStart.split(":").map(Number);
  const [eh, em] = state.settings.officeEnd.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= start && cur < end;
}
export { isWithinOfficeHours };

// ---- M3.B: after-hours device alert ----
registerAlertCheck(function afterHoursDeviceCheck() {
  if (!state.settings.rules.afterHours) return;
  const afterHours = !isWithinOfficeHours();
  for (const d of state.devices) {
    const key = `after-hours:${d.id}`;
    const active = findActiveAlert((a) => a.type === "after-hours" && a.deviceId === d.id);
    if (afterHours && d.status === "on") {
      if (!active) {
        createAlert({
          type: "after-hours",
          severity: "warning",
          roomId: d.room,
          deviceId: d.id,
          title: "After-hours device active",
          message: `${d.name} is on outside office hours (${state.settings.officeStart}-${state.settings.officeEnd}).`,
        });
      }
    } else if (active) {
      resolveAlert(active);
    }
  }
});

// ---- M3.B: >2h continuous run alert ----
registerAlertCheck(function longRunningDeviceCheck() {
  const THRESHOLD_MS = 2 * 3600 * 1000;
  for (const d of state.devices) {
    const active = findActiveAlert((a) => a.type === "long-running" && a.deviceId === d.id);
    const onMs = d.status === "on" ? continuousOnDurationMs(d.id) : 0;
    if (d.status === "on" && onMs >= THRESHOLD_MS) {
      if (!active) {
        createAlert({
          type: "long-running",
          severity: "warning",
          roomId: d.room,
          deviceId: d.id,
          title: "Device running continuously for 2h+",
          message: `${d.name} has been on for over 2 hours without interruption.`,
        });
      }
    } else if (active) {
      resolveAlert(active);
    }
  }
});

// ---- M4.B: poor ventilation (CO2) alert ----
registerAlertCheck(function ventilationCheck() {
  for (const room of ROOMS) {
    const env = state.environment[room.id];
    const active = findActiveAlert((a) => a.type === "ventilation" && a.roomId === room.id);
    if (env.co2Ppm > state.settings.co2Threshold) {
      if (!active) {
        createAlert({
          type: "ventilation",
          severity: "info",
          roomId: room.id,
          title: "CO\u2082 trending up",
          message: `${room.name} CO\u2082 at ${Math.round(env.co2Ppm)}ppm, above the ${state.settings.co2Threshold}ppm threshold.`,
        });
      }
    } else if (active) {
      resolveAlert(active);
    }
  }
});

// ---- M7.B: fire/smoke alert (highest severity) ----
registerAlertCheck(function fireCheck() {
  if (!state.settings.rules.fireMonitoring) return;
  for (const room of ROOMS) {
    const active = findActiveAlert((a) => a.type === "fire" && a.roomId === room.id);
    const smoke = state.smokeLevel[room.id];
    const isFire = smoke >= state.settings.smokeThreshold;
    state.fireAlert[room.id] = isFire;
    if (isFire) {
      if (!active) {
        createAlert({
          type: "fire",
          severity: "critical",
          roomId: room.id,
          title: "FIRE / SMOKE DETECTED",
          message: `Smoke level in ${room.name} at ${Math.round(smoke)} — above the ${state.settings.smokeThreshold} threshold.`,
        });
      }
    } else if (active) {
      resolveAlert(active);
    }
  }
});

// ---- M6/M7: PC after-hours alert ----
registerAlertCheck(function pcAfterHoursCheck() {
  if (!state.settings.rules.pcMonitoring) return;
  const afterHours = !isWithinOfficeHours();
  for (const pc of state.pcs) {
    const active = findActiveAlert((a) => a.type === "pc-after-hours" && a.deviceId === pc.id);
    if (afterHours && pc.on) {
      if (!active) {
        createAlert({
          type: "pc-after-hours",
          severity: "warning",
          roomId: pc.room,
          deviceId: pc.id,
          title: "Workstation active after hours",
          message: `${pc.id} is on outside office hours.`,
        });
      }
    } else if (active) {
      resolveAlert(active);
    }
  }
});

export function runAlertChecks() {
  for (const check of checks) check();
}
