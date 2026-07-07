// Persists periodic cost snapshots for analytics

import { ROOMS, WATTAGE } from "./schema.js";
import { state, onTimeHoursSince } from "./state.js";
import { db } from "./db.js";

// One tick's worth of cost data
export function computeInstantCost(windowMs) {
  const rate = state.settings.kwhRate;
  const perDevice = state.devices.map((d) => {
    const onHours = onTimeHoursSince(d.id, windowMs);
    const kwh = (d.wattage / 1000) * onHours;
    return { device: d, kwh, cost: kwh * rate };
  });
  const perRoom = ROOMS.map((r) => {
    const rows = perDevice.filter((x) => x.device.room === r.id);
    return {
      room: r.id,
      name: r.name,
      cost: rows.reduce((s, x) => s + x.cost, 0),
      kwh: rows.reduce((s, x) => s + x.kwh, 0),
    };
  });
  const perType = Object.keys(WATTAGE).map((t) => {
    const rows = perDevice.filter((x) => x.device.type === t);
    return {
      type: t,
      cost: rows.reduce((s, x) => s + x.cost, 0),
      kwh: rows.reduce((s, x) => s + x.kwh, 0),
    };
  });
  const totalCost = perRoom.reduce((s, r) => s + r.cost, 0);
  const totalKwh = perRoom.reduce((s, r) => s + r.kwh, 0);
  return { totalCost, totalKwh, kwhRate: rate, perRoom, perType };
}

const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000; // one row every 15 minutes is plenty for weekly/monthly/annual charts
let lastSnapshotAt = 0;

// Called from simulator tick, cheap no-op
export function maybeRecordCostSnapshot() {
  const now = Date.now();
  if (now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
  const windowMs = lastSnapshotAt ? now - lastSnapshotAt : SNAPSHOT_INTERVAL_MS;
  lastSnapshotAt = now;
  const snap = computeInstantCost(windowMs);
  db.append("costSnapshots", { t: now, ...snap });
  db.pruneCostSnapshots();
}

const PERIOD_MS = {
  daily: 24 * 3600 * 1000,
  weekly: 7 * 24 * 3600 * 1000,
  monthly: 30 * 24 * 3600 * 1000,
  annual: 365 * 24 * 3600 * 1000,
};

export function aggregateCost(period) {
  const windowMs = PERIOD_MS[period] || PERIOD_MS.weekly;
  const since = Date.now() - windowMs;
  const rows = db.get().costSnapshots.filter((s) => s.t >= since);

  const perRoomMap = new Map();
  const perTypeMap = new Map();
  let totalCost = 0;
  let totalKwh = 0;

  for (const row of rows) {
    totalCost += row.totalCost;
    totalKwh += row.totalKwh;
    for (const r of row.perRoom) {
      const cur = perRoomMap.get(r.room) || { room: r.room, name: r.name, cost: 0, kwh: 0 };
      cur.cost += r.cost;
      cur.kwh += r.kwh;
      perRoomMap.set(r.room, cur);
    }
    for (const t of row.perType) {
      const cur = perTypeMap.get(t.type) || { type: t.type, cost: 0, kwh: 0 };
      cur.cost += t.cost;
      cur.kwh += t.kwh;
      perTypeMap.set(t.type, cur);
    }
  }

  // Fold in live-so-far usage too
  const live = computeInstantCost(Math.min(windowMs, 24 * 3600 * 1000));
  if (rows.length === 0) {
    return {
      period,
      windowMs,
      sampleCount: 0,
      totalCost: live.totalCost,
      totalKwh: live.totalKwh,
      kwhRate: state.settings.kwhRate,
      perRoom: live.perRoom.sort((a, b) => b.cost - a.cost),
      perType: live.perType,
      note: "Not enough history yet — showing current live estimate. Real history accumulates every 15 minutes.",
    };
  }

  return {
    period,
    windowMs,
    sampleCount: rows.length,
    totalCost,
    totalKwh,
    kwhRate: state.settings.kwhRate,
    perRoom: [...perRoomMap.values()].sort((a, b) => b.cost - a.cost),
    perType: [...perTypeMap.values()],
  };
}

export function dailySeries(period) {
  const windowMs = PERIOD_MS[period] || PERIOD_MS.weekly;
  const since = Date.now() - windowMs;
  const rows = db.get().costSnapshots.filter((s) => s.t >= since);
  const byDay = new Map();
  for (const row of rows) {
    const day = new Date(row.t).toISOString().slice(0, 10);
    const cur = byDay.get(day) || { day, cost: 0, kwh: 0 };
    cur.cost += row.totalCost;
    cur.kwh += row.totalKwh;
    byDay.set(day, cur);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
