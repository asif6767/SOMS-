import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import WebSocket from "ws";
import {
  getSnapshot, getRoom, getPower, getEstimatedKwhToday,
  getAlerts, getCost, getWeather, getSettings, listRooms,
  setDevice, setRoomAuto, setSystemPower, addRoom, removeRoom,
  setLocation, setHowToUse,
} from "./somsClient.js";
import {
  formatStatus, formatRoom, formatUsage, formatAlertPush, formatRoomNotFound,
  formatAlerts, formatCost, formatWeather, formatRoomsList, formatSettings,
  formatSystemPower, formatHowTo,
} from "./formatters.js";
import { resolveRoom, ROOM_IDS } from "./rooms.js";
import { humanize } from "./llm.js";

// ---------------- admin gating ----------------
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
// SECURITY FIX: the previous version granted admin/control access to ANY
// direct message to the bot, on the theory that a DM implies "bot owner
// context." That's not true — anyone who can find the bot (any shared
// server) can DM it. Control access in DMs now requires being explicitly
// listed in DISCORD_OWNER_IDS.
const OWNER_IDS = (process.env.DISCORD_OWNER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(message) {
  if (!message.guild || !message.member) {
    // Direct message: only explicitly configured owners get control access.
    return OWNER_IDS.includes(message.author.id);
  }
  if (message.member.permissions?.has("ManageGuild")) return true;
  if (ADMIN_ROLE_ID && message.member.roles?.cache?.has(ADMIN_ROLE_ID)) return true;
  return false;
}

// ---------------- per-user rate limiting ----------------
// Caps command throughput per Discord user so the bot (and the backend it
// talks to) can't be hammered by a single account, compromised or not.
const COMMAND_WINDOW_MS = 60_000;
const MAX_COMMANDS_PER_WINDOW = 20;
const commandHistory = new Map(); // userId -> { count, windowStart }

function isRateLimited(userId) {
  const now = Date.now();
  const entry = commandHistory.get(userId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > COMMAND_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  commandHistory.set(userId, entry);
  return entry.count > MAX_COMMANDS_PER_WINDOW;
}

function requireAdmin(message) {
  if (isAdmin(message)) return true;
  message.reply("🔒 That command changes live office state, so it's limited to admins (Manage Server permission, or the configured admin role).");
  return false;
}

// Sends template text, or LLM rewrite if set
async function reply(message, templateText, context) {
  const rewritten = await humanize(templateText, context);
  await message.reply(rewritten || templateText);
}

const PREFIX = "!";
const ALERTS_CHANNEL_ID = process.env.ALERTS_CHANNEL_ID || "";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// ---------------- commands ----------------

async function handleStatus(message) {
  const { devices } = await getSnapshot();
  await reply(message, formatStatus(devices), "office-wide device status summary");
}

async function handleRoom(message, arg) {
  const roomId = resolveRoom(arg);
  if (!roomId) {
    await message.reply(formatRoomNotFound(arg, ROOM_IDS));
    return;
  }
  const room = await getRoom(roomId);
  await reply(message, formatRoom(roomId, room), `single-room status for ${roomId}`);
}

async function handleUsage(message) {
  const [power, kwhToday] = await Promise.all([getPower(), getEstimatedKwhToday()]);
  await reply(message, formatUsage(power.total, kwhToday, power.perRoom), "power usage summary");
}

async function handleHelp(message) {
  await message.reply(
    [
      "**Read-only (anyone):**",
      "`!status` — quick on/off summary for every room",
      "`!room <name>` — detail for one room (e.g. `!room work1`, `!room drawing`)",
      "`!usage` — total power right now + today's estimated kWh",
      "`!rooms` — list every room",
      "`!alerts` — active alerts",
      "`!cost` — today's estimated cost",
      "`!weather` — current weather + hourly forecast for the saved location",
      "`!settings` — current admin settings",
      "`!howto` — the \"how to use SOMS\" video link + guidelines",
      "",
      "**Control (admins only):**",
      "`!on` / `!off` — power the whole office on/off",
      "`!device <id> on|off` — toggle one device, e.g. `!device work1-light1 off`",
      "`!auto <room> on|off` — toggle automatic control for a room",
      "`!addroom <name> [fans] [lights] [acs] [computers]`",
      "`!removeroom <room>`",
      "`!setlocation <lat> <lon> [label]` — change the weather pinpoint",
      "`!sethowto <youtubeUrl> | <guidelines text>` — update the how-to video/guidelines",
    ].join("\n")
  );
}

async function handleRooms(message) {
  const { rooms } = await listRooms();
  await message.reply(formatRoomsList(rooms));
}

async function handleAlerts(message) {
  const { alerts } = await getAlerts();
  await message.reply(formatAlerts(alerts));
}

async function handleCost(message) {
  const cost = await getCost();
  await message.reply(formatCost(cost));
}

async function handleWeather(message) {
  const w = await getWeather().catch(() => null);
  await message.reply(formatWeather(w));
}

async function handleSettings(message) {
  const s = await getSettings();
  await message.reply(formatSettings(s));
}

async function handleHowTo(message) {
  const s = await getSettings();
  await message.reply(formatHowTo(s.howToUse));
}

async function handlePower(message, enabled) {
  if (!requireAdmin(message)) return;
  const result = await setSystemPower(enabled, `discord:${message.author.tag}`);
  await reply(message, formatSystemPower(result.enabled), "master power toggle");
}

async function handleDevice(message, args) {
  if (!requireAdmin(message)) return;
  const [deviceId, statusRaw] = args;
  const status = String(statusRaw || "").toLowerCase();
  if (!deviceId || (status !== "on" && status !== "off")) {
    return message.reply("Usage: `!device <device-id> on|off` (find device ids with `!room <name>`).");
  }
  await setDevice(deviceId, status);
  await message.reply(`✅ \`${deviceId}\` is now **${status.toUpperCase()}**.`);
}

async function handleAuto(message, args) {
  if (!requireAdmin(message)) return;
  const [roomArg, stateRaw] = args;
  const roomId = resolveRoom(roomArg);
  const enabled = String(stateRaw || "").toLowerCase();
  if (!roomId || (enabled !== "on" && enabled !== "off")) {
    return message.reply("Usage: `!auto <room> on|off`");
  }
  await setRoomAuto(roomId, enabled === "on");
  await message.reply(`✅ Automation for **${roomId}** is now **${enabled.toUpperCase()}**.`);
}

async function handleAddRoom(message, args) {
  if (!requireAdmin(message)) return;
  const [name, fans, lights, acs, computers] = args;
  if (!name) return message.reply("Usage: `!addroom <name> [fans] [lights] [acs] [computers]`");
  const room = await addRoom({
    name,
    fans: fans !== undefined ? Number(fans) : undefined,
    lights: lights !== undefined ? Number(lights) : undefined,
    acs: acs !== undefined ? Number(acs) : undefined,
    computers: computers !== undefined ? Number(computers) : undefined,
  });
  await message.reply(`✅ Room **${room.room.name}** (\`${room.room.id}\`) created.`);
}

async function handleRemoveRoom(message, args) {
  if (!requireAdmin(message)) return;
  const roomId = resolveRoom(args.join(" "));
  if (!roomId) return message.reply("Usage: `!removeroom <room>`");
  await removeRoom(roomId);
  await message.reply(`🗑️ Room **${roomId}** removed.`);
}

async function handleSetLocation(message, args) {
  if (!requireAdmin(message)) return;
  const [latRaw, lonRaw, ...labelParts] = args;
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return message.reply("Usage: `!setlocation <lat> <lon> [label]`, e.g. `!setlocation 23.81 90.41 Dhaka`");
  }
  await setLocation(lat, lon, labelParts.join(" ") || undefined);
  await message.reply(`📍 Weather location updated to **${lat}, ${lon}**${labelParts.length ? ` (${labelParts.join(" ")})` : ""}.`);
}

async function handleSetHowTo(message, rest) {
  if (!requireAdmin(message)) return;
  const [urlPart, ...guidelineParts] = rest.split("|");
  const youtubeUrl = urlPart.trim();
  const guidelines = guidelineParts.join("|").trim();
  if (!youtubeUrl) return message.reply("Usage: `!sethowto <youtubeUrl> | <guidelines text>`");
  await setHowToUse({ youtubeUrl, guidelines: guidelines || undefined });
  await message.reply("✅ How-to video/guidelines updated.");
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  if (isRateLimited(message.author.id)) {
    return message.reply("⏳ Slow down a little — you're sending commands faster than I can process them safely.");
  }

  const body = message.content.slice(PREFIX.length).trim();
  const [cmdRaw, ...rest] = body.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const restRawText = body.slice(cmdRaw.length).trim(); // preserves "|" etc. for !sethowto

  try {
    if (cmd === "status") return await handleStatus(message);
    if (cmd === "room") return await handleRoom(message, rest.join(" "));
    if (cmd === "usage") return await handleUsage(message);
    if (cmd === "help" || cmd === "soms") return await handleHelp(message);
    if (cmd === "rooms") return await handleRooms(message);
    if (cmd === "alerts") return await handleAlerts(message);
    if (cmd === "cost") return await handleCost(message);
    if (cmd === "weather") return await handleWeather(message);
    if (cmd === "settings") return await handleSettings(message);
    if (cmd === "howto") return await handleHowTo(message);
    if (cmd === "on") return await handlePower(message, true);
    if (cmd === "off") return await handlePower(message, false);
    if (cmd === "device") return await handleDevice(message, rest);
    if (cmd === "auto") return await handleAuto(message, rest);
    if (cmd === "addroom") return await handleAddRoom(message, rest);
    if (cmd === "removeroom") return await handleRemoveRoom(message, rest);
    if (cmd === "setlocation") return await handleSetLocation(message, rest);
    if (cmd === "sethowto") return await handleSetHowTo(message, restRawText);
  } catch (err) {
    console.error(`[soms-bot] command '${cmd}' failed:`, err.message);
    await message.reply("⚠️ I couldn't reach the office backend just now — try again in a moment.");
  }
});

// ---------------- bonus: proactive alert push ----------------

function connectAlertsSocket() {
  if (!ALERTS_CHANNEL_ID) {
    console.warn("[soms-bot] ALERTS_CHANNEL_ID not set — proactive alert push disabled.");
    return;
  }
  const wsUrl = process.env.SOMS_WS_URL || "ws://localhost:4000/ws/live";
  const token = process.env.SOMS_AUTH_TOKEN || "";
  const ws = new WebSocket(token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl);

  ws.on("open", () => console.log("[soms-bot] connected to backend WS for proactive alerts"));

  ws.on("message", async (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (evt.event !== "alert:new") return;
    const alert = evt.payload;
    if (!alert) return;
    try {
      const channel = await client.channels.fetch(ALERTS_CHANNEL_ID);
      if (channel) await channel.send(formatAlertPush(alert));
    } catch (err) {
      console.error("[soms-bot] failed to post proactive alert:", err.message);
    }
  });

  ws.on("close", () => {
    console.warn("[soms-bot] backend WS closed — reconnecting in 5s");
    setTimeout(connectAlertsSocket, 5000);
  });
  ws.on("error", (err) => console.error("[soms-bot] backend WS error:", err.message));
}

client.once("ready", () => {
  console.log(`[soms-bot] logged in as ${client.user.tag}`);
  connectAlertsSocket();
});

client.login(process.env.DISCORD_TOKEN);
