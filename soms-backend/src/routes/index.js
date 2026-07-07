import { Router } from "express";
import { ROOMS, isValidRoom, DEVICE_TYPES } from "../schema.js";
import { state, stateLock, recordDeviceChange, onTimeHoursSince } from "../state.js";
import { buildSnapshot } from "../snapshot.js";
import { broadcast } from "../ws/broadcaster.js";
import { setDeviceStatus } from "../simulator.js";
import { ingestTelemetry, getCommands, getHardwareStatus } from "../hardware.js";
import { addRoom, removeRoom, listRoomsSummary, getRoomAuditLog, setRoomAuto, RoomValidationError } from "../roomsManager.js";
import { fetchWeather, reverseGeocode } from "../weather.js";
import { setSystemPower, isSystemEnabled } from "../systemControl.js";
import { aggregateCost, dailySeries } from "../costHistory.js";
import { streamCostReportPdf } from "../pdfExport.js";
import { db } from "../db.js";

export const router = Router();

function errorBody(error, message, details) {
  const body = { error, message };
  if (details) body.details = details;
  return body;
}

function roomPublicShape(roomId) {
  const room = ROOMS.find((r) => r.id === roomId);
  const devices = state.devices.filter((d) => d.room === roomId);
  const pcs = state.pcs.filter((p) => p.room === roomId);
  return {
    id: room.id,
    name: room.name,
    devices,
    environment: state.environment[roomId],
    occupancyCount: state.occupancy[roomId],
    pcs, // empty array for Drawing Room, by design
  };
}

// ---------------- M1.A: devices + rooms ----------------

router.get("/devices", (req, res) => {
  res.json({ devices: state.devices, updatedAt: new Date().toISOString() });
});

router.patch("/devices/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (status !== "on" && status !== "off") {
    return res.status(400).json(errorBody("bad_request", "Body must include status: 'on'|'off'."));
  }
  const device = state.devices.find((d) => d.id === id);
  if (!device) {
    return res.status(404).json(errorBody("not_found", `No device with id '${id}'.`));
  }
  await stateLock.withLock(async () => {
    setDeviceStatus(id, status);
  });
  broadcast("state:diff", { devices: [device] });
  res.json({ device });
});

// ---------------- Room builder (Settings -> Manage Rooms) 

router.get("/rooms/audit-log", (req, res) => {
  res.json({ entries: getRoomAuditLog() });
});

router.get("/rooms", (req, res) => {
  res.json({ rooms: listRoomsSummary(), deviceTypes: DEVICE_TYPES });
});

router.post("/rooms", async (req, res, next) => {
  const { name, fans, lights, acs, computers } = req.body || {};
  try {
    let room;
    await stateLock.withLock(async () => {
      room = addRoom({ name, fans, lights, acs, computers });
    });
    res.status(201).json({ room, rooms: listRoomsSummary() });
  } catch (err) {
    if (err instanceof RoomValidationError) {
      return res.status(400).json(errorBody("bad_request", err.message));
    }
    next(err);
  }
});

router.delete("/rooms/:room", async (req, res) => {
  const { room } = req.params;
  if (!isValidRoom(room)) {
    return res.status(404).json(errorBody("not_found", `Unknown room '${room}'.`));
  }
  let removed;
  await stateLock.withLock(async () => {
    removed = removeRoom(room);
  });
  res.json({ removed, rooms: listRoomsSummary() });
});

// The room-level AUTO button toggle
router.patch("/rooms/:room/auto", async (req, res) => {
  const { room } = req.params;
  const { enabled } = req.body || {};
  if (!isValidRoom(room)) {
    return res.status(404).json(errorBody("not_found", `Unknown room '${room}'.`));
  }
  if (typeof enabled !== "boolean") {
    return res.status(400).json(errorBody("bad_request", "Body must include enabled: boolean."));
  }
  const automation = setRoomAuto(room, enabled);
  res.json({ automation });
});

router.get("/rooms/:room", (req, res) => {
  const { room } = req.params;
  if (!isValidRoom(room)) {
    return res
      .status(404)
      .json(errorBody("not_found", `Unknown room '${room}'. Valid rooms: ${ROOMS.map((r) => r.id).join(", ")}.`));
  }
  res.json(roomPublicShape(room));
});

// ---------------- M4.A: environment ----------------

router.get("/environment/:room", (req, res) => {
  const { room } = req.params;
  if (!isValidRoom(room)) {
    return res.status(404).json(errorBody("not_found", `Unknown room '${room}'.`));
  }
  res.json(state.environment[room]);
});

// ---------------- M8.C: power ----------------

router.get("/power", (req, res) => {
  const perRoom = ROOMS.map((r) => {
    const wattage = state.devices
      .filter((d) => d.room === r.id && d.status === "on")
      .reduce((sum, d) => sum + d.wattage, 0);
    return { room: r.id, name: r.name, wattage };
  });
  const total = perRoom.reduce((sum, r) => sum + r.wattage, 0);
  res.json({ total, perRoom, updatedAt: new Date().toISOString() });
});

// ---------------- M3.A: alerts ----------------

router.get("/alerts", (req, res) => {
  const sorted = [...state.alerts].sort((a, b) => {
    const sevOrder = { critical: 0, warning: 1, info: 2 };
    if (!!a.resolvedAt !== !!b.resolvedAt) return a.resolvedAt ? 1 : -1;
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  res.json({ alerts: sorted, activeCount: sorted.filter((a) => !a.resolvedAt).length });
});

// ---------------- M5.A: cost ----------------

router.get("/cost", (req, res) => {
  const rate = state.settings.kwhRate;
  const hoursElapsed = Math.max(1 / 60, new Date().getHours() + new Date().getMinutes() / 60);

  const perDevice = state.devices.map((d) => {
    const onHoursToday = onTimeHoursSince(d.id, hoursElapsed * 3600 * 1000);
    const cost = (d.wattage / 1000) * onHoursToday * rate;
    return { device: d, onHoursToday, cost };
  });

  const costPerRoom = ROOMS.map((r) => {
    const cost = perDevice.filter((x) => x.device.room === r.id).reduce((s, x) => s + x.cost, 0);
    return { room: r.id, name: r.name, cost };
  }).sort((a, b) => b.cost - a.cost);

  const types = ["fan", "light"];
  const costPerDeviceType = types.map((t) => {
    const cost = perDevice.filter((x) => x.device.type === t).reduce((s, x) => s + x.cost, 0);
    return { type: t, cost };
  });

  const topDevices = [...perDevice]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 3)
    .map((x) => ({ id: x.device.id, name: x.device.name, room: x.device.room, wattage: x.device.wattage, cost: x.cost }));

  const total = costPerRoom.reduce((s, r) => s + r.cost, 0);

  res.json({
    total,
    ratePerKwh: rate,
    costPerRoom,
    costPerDeviceType,
    topDevices,
    updatedAt: new Date().toISOString(),
  });
});

// ---------------- Master power (whole-office ON/OFF) ----------------

router.get("/system", (req, res) => {
  res.json({ enabled: isSystemEnabled() });
});

router.post("/system/power", async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json(errorBody("bad_request", "Body must include enabled: boolean."));
  }
  const actor = req.body.actor || "dashboard";
  const result = await setSystemPower(enabled, { actor });
  res.json(result);
});

// ---------------- M6.A: settings ----------------

router.get("/settings", (req, res) => {
  res.json(state.settings);
});

router.patch("/settings", async (req, res) => {
  const body = req.body || {};
  const errors = [];

  if (body.officeStart !== undefined && !/^\d{2}:\d{2}$/.test(body.officeStart)) {
    errors.push("officeStart must be HH:MM");
  }
  if (body.officeEnd !== undefined && !/^\d{2}:\d{2}$/.test(body.officeEnd)) {
    errors.push("officeEnd must be HH:MM");
  }
  if (body.kwhRate !== undefined && (typeof body.kwhRate !== "number" || body.kwhRate < 0)) {
    errors.push("kwhRate must be a non-negative number");
  }
  if (body.co2Threshold !== undefined && (typeof body.co2Threshold !== "number" || body.co2Threshold < 0)) {
    errors.push("co2Threshold must be a non-negative number");
  }
  if (body.smokeThreshold !== undefined && (typeof body.smokeThreshold !== "number" || body.smokeThreshold < 0)) {
    errors.push("smokeThreshold must be a non-negative number");
  }
  if (body.location !== undefined && body.location !== null) {
    const { lat, lon } = body.location;
    if (typeof lat !== "number" || typeof lon !== "number" || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push("location must be { lat: number(-90..90), lon: number(-180..180), label?: string }");
    }
  }
  if (body.howToUse !== undefined && body.howToUse !== null) {
    const { youtubeUrl, guidelines } = body.howToUse;
    if (youtubeUrl !== undefined && typeof youtubeUrl !== "string") {
      errors.push("howToUse.youtubeUrl must be a string");
    }
    if (guidelines !== undefined && typeof guidelines !== "string") {
      errors.push("howToUse.guidelines must be a string");
    }
  }
  if (errors.length) {
    return res.status(400).json(errorBody("bad_request", "Invalid settings payload.", errors));
  }

  await stateLock.withLock(async () => {
    Object.assign(state.settings, {
      officeStart: body.officeStart ?? state.settings.officeStart,
      officeEnd: body.officeEnd ?? state.settings.officeEnd,
      kwhRate: body.kwhRate ?? state.settings.kwhRate,
      co2Threshold: body.co2Threshold ?? state.settings.co2Threshold,
      smokeThreshold: body.smokeThreshold ?? state.settings.smokeThreshold,
      currency: body.currency ?? state.settings.currency,
      location: body.location !== undefined ? body.location : state.settings.location,
    });
    if (body.howToUse && typeof body.howToUse === "object") {
      state.settings.howToUse = { ...state.settings.howToUse, ...body.howToUse };
    }
    if (body.rules && typeof body.rules === "object") {
      Object.assign(state.settings.rules, body.rules);
    }
    db.set({ settings: state.settings });
  });

  if (body.location && typeof body.location.lat === "number") {
    fetchWeather(body.location.lat, body.location.lon)
      .then((w) => {
        state.weather = w;
        broadcast("state:diff", { weather: w });
      })
      .catch((err) => console.warn("[settings] immediate weather fetch failed:", err.message));
  }

  broadcast("state:diff", { settings: state.settings });
  res.json(state.settings);
});

// ---------------- M6.B/M7.C: automation ----------------

router.get("/automation", (req, res) => {
  res.json({ automation: state.automation, rules: state.settings.rules });
});

router.patch("/automation/:room", async (req, res) => {
  const { room } = req.params;
  if (!isValidRoom(room)) {
    return res.status(404).json(errorBody("not_found", `Unknown room '${room}'.`));
  }
  const { autoControlEnabled } = req.body || {};
  if (typeof autoControlEnabled !== "boolean") {
    return res.status(400).json(errorBody("bad_request", "Body must include autoControlEnabled: boolean."));
  }
  state.automation[room].autoControlEnabled = autoControlEnabled;
  broadcast("state:diff", { automation: { [room]: state.automation[room] } });
  res.json(state.automation[room]);
});

// ---------------- Live weather (Open-Meteo) ----------------

router.get("/weather", async (req, res) => {
  const lat = Number(req.query.lat ?? state.settings.location?.lat);
  const lon = Number(req.query.lon ?? state.settings.location?.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json(errorBody("bad_request", "Provide ?lat=&lon= or save a location via PATCH /settings first."));
  }
  try {
    const weather = await fetchWeather(lat, lon);
    state.weather = weather;
    res.json(weather);
  } catch (err) {
    res.status(502).json(errorBody("weather_upstream_error", `Could not reach Open-Meteo: ${err.message}`));
  }
});

// ---------------- Cost history / analytics export ----------------

router.get("/cost/history", (req, res) => {
  const period = ["daily", "weekly", "monthly", "annual"].includes(req.query.period) ? req.query.period : "weekly";
  res.json({ ...aggregateCost(period), series: dailySeries(period) });
});

router.get("/cost/export", (req, res) => {
  const period = ["daily", "weekly", "monthly", "annual"].includes(req.query.period) ? req.query.period : "weekly";
  try {
    streamCostReportPdf(period, res);
  } catch (err) {
    res.status(500).json(errorBody("pdf_export_failed", err.message));
  }
});

// ---------------- Brand image / avatar upload ----------------

router.get("/avatar", (req, res) => {
  res.json(db.get().avatar || null);
});

router.post("/avatar", async (req, res) => {
  const { dataUrl, mime } = req.body || {};
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return res.status(400).json(errorBody("bad_request", "Body must include dataUrl as a data: URL (image or gif)."));
  }
  // ~6MB cap on the base64 payload
  if (dataUrl.length > 8_000_000) {
    return res.status(413).json(errorBody("payload_too_large", "Image is too large — please use something under ~5MB."));
  }
  const avatar = { dataUrl, mime: mime || dataUrl.slice(5, dataUrl.indexOf(";")), updatedAt: new Date().toISOString() };
  db.set({ avatar });
  broadcast("state:diff", { avatar });
  res.json(avatar);
});

router.delete("/avatar", (req, res) => {
  db.set({ avatar: null });
  broadcast("state:diff", { avatar: null });
  res.json({ ok: true });
});

// ---------------- Feedback / comments (Settings > Help) ----------------

router.get("/feedback", (req, res) => {
  res.json(db.get().feedback || []);
});

router.post("/feedback", (req, res) => {
  const text = (req.body || {}).text;
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json(errorBody("bad_request", "Body must include non-empty text."));
  }
  const entry = { id: `fb-${Date.now()}-${Math.floor(Math.random() * 1000)}`, text: text.trim(), at: new Date().toISOString() };
  const feedback = [...(db.get().feedback || []), entry];
  db.set({ feedback });
  broadcast("state:diff", { feedback });
  res.json(entry);
});

// ---------------- Hardware bridge (ESP32 room nodes) ----------------

router.get("/hardware", getHardwareStatus);
router.post("/hardware/:room/telemetry", ingestTelemetry);
router.get("/hardware/:room/commands", getCommands);

// ---------------- snapshot (used by frontend on load/reconnect) ----------------

router.get("/snapshot", (req, res) => {
  res.json({
    ...buildSnapshot(),
    rooms: ROOMS.map((r) => roomPublicShape(r.id)),
    roomsSummary: listRoomsSummary(),
    avatar: db.get().avatar || null,
  });
});
