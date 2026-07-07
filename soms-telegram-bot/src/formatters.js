// Same data-to-text logic as the Discord bot

const ROOM_LABEL = { drawing: "Drawing Room", work1: "Work Room 1", work2: "Work Room 2" };

function roomSummary(devices) {
  const fansOn = devices.filter((d) => d.type === "fan" && d.status === "on").length;
  const lightsOn = devices.filter((d) => d.type === "light" && d.status === "on").length;
  if (fansOn === 0 && lightsOn === 0) return "all off";
  const parts = [];
  if (fansOn > 0) parts.push(`${fansOn} fan${fansOn === 1 ? "" : "s"} ON`);
  if (lightsOn > 0) parts.push(`${lightsOn} light${lightsOn === 1 ? "" : "s"} ON`);
  return parts.join(", ");
}

export function formatStatus(devices) {
  const byRoom = ["drawing", "work1", "work2"].map((roomId) => {
    const roomDevices = devices.filter((d) => d.room === roomId);
    return `${ROOM_LABEL[roomId] || roomId}: ${roomSummary(roomDevices)}.`;
  });
  return `🏢 <b>Office status right now</b>\n${byRoom.join(" ")}`;
}

export function formatRoom(roomId, room) {
  const label = ROOM_LABEL[roomId] || room.name || roomId;
  const lines = room.devices.map((d) => `${d.status === "on" ? "🟢" : "⚪"} ${d.name} (<code>${d.id}</code>) — ${d.status.toUpperCase()}`);
  const watts = room.devices.filter((d) => d.status === "on").reduce((s, d) => s + d.wattage, 0);
  return [`📍 <b>${label}</b>`, ...lines, "", `Drawing <b>${watts}W</b> right now.`].join("\n");
}

export function formatUsage(totalWatts, kwhToday, perRoom) {
  const roomLine = perRoom.map((r) => `${ROOM_LABEL[r.room] || r.room}: ${r.wattage}W`).join(" · ");
  return [`⚡ <b>Total power right now: ${totalWatts}W</b>`, `Today's estimated usage so far: <b>${kwhToday.toFixed(1)} kWh</b>`, roomLine].join("\n");
}

export function formatAlertPush(alert) {
  const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "⚠️" : "ℹ️";
  const roomLabel = ROOM_LABEL[alert.roomId] || alert.roomId;
  return `${icon} Hey! ${roomLabel} — ${alert.message}`;
}

export function formatRoomNotFound(input, validRooms) {
  return `I don't know a room called "${input}". Try one of: ${validRooms.join(", ")} (or their names, like "work room 1").`;
}

export function formatAlerts(alerts) {
  const active = (alerts || []).filter((a) => !a.resolvedAt);
  if (!active.length) return "✅ No active alerts right now.";
  const icon = (a) => (a.severity === "critical" ? "🔴" : a.severity === "warning" ? "⚠️" : "ℹ️");
  return [`🚨 <b>${active.length} active alert${active.length === 1 ? "" : "s"}</b>`, ...active.map((a) => `${icon(a)} [${a.roomId}] ${a.title || a.message}`)].join("\n");
}

export function formatCost(cost) {
  return [`💰 <b>Estimated cost today: ${cost.currencySymbol || "$"}${Number(cost.total || 0).toFixed(2)}</b>`, `Rate: ${cost.ratePerKwh} / kWh`].join("\n");
}

export function formatWeather(w) {
  if (!w || w.temperatureC === undefined) {
    return "Weather isn't set up yet — save a location from the dashboard (or use /setlocation) first.";
  }
  const place = w.label || `${w.lat?.toFixed(2)}, ${w.lon?.toFixed(2)}`;
  const lines = [
    `🌤️ <b>${place}</b> — ${Math.round(w.temperatureC)}°C, ${w.conditionLabel}`,
    `Feels like ${Math.round(w.apparentTemperatureC)}°C · Humidity ${w.humidityPct}% · Wind ${Math.round(w.windSpeedKmh)} km/h`,
  ];
  if (Array.isArray(w.hourly) && w.hourly.length) {
    const strip = w.hourly.slice(0, 5).map((h) => `${new Date(h.time).getHours()}:00 ${Math.round(h.temperatureC)}° (${h.precipitationPct}%💧)`);
    lines.push(strip.join("  ·  "));
  }
  return lines.join("\n");
}

export function formatRoomsList(rooms) {
  return [`🏠 <b>Rooms (${rooms.length})</b>`, ...rooms.map((r) => `<code>${r.id}</code> — ${r.name} (${r.deviceCount ?? "?"} devices)`)].join("\n");
}

export function formatSettings(s) {
  return [
    `⚙️ <b>Settings</b>`,
    `Office hours: ${s.officeStart}–${s.officeEnd}`,
    `Rate: ${s.kwhRate} ${s.currency}/kWh`,
    `CO₂ threshold: ${s.co2Threshold} ppm · Smoke threshold: ${s.smokeThreshold}`,
    `System power: ${s.systemEnabled === false ? "🔴 OFF" : "🟢 ON"}`,
    `Location: ${s.location ? (s.location.label || `${s.location.lat}, ${s.location.lon}`) : "not set"}`,
  ].join("\n");
}

export function formatSystemPower(enabled) {
  return enabled
    ? "🟢 <b>Office powered ON.</b> Devices and automation are back under normal control."
    : "🔴 <b>Office powered OFF.</b> Every device has been switched off and automation is paused until it's turned back on.";
}

export function formatHowTo(howToUse) {
  return [`📺 <b>How to use SOMS</b>`, howToUse?.youtubeUrl || "(no video link set yet)", "", howToUse?.guidelines || ""].join("\n");
}
