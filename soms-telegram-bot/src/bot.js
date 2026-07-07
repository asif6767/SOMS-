// Telegram counterpart to the Discord bot

import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
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

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("[soms-telegram-bot] TELEGRAM_BOT_TOKEN is not set — see .env.example.");
  process.exit(1);
}

// Telegram user ids allowed to run controls
const ADMIN_IDS = (process.env.ADMIN_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(msg) {
  if (!ADMIN_IDS.length) return true;
  return ADMIN_IDS.includes(String(msg.from?.id));
}

const bot = new TelegramBot(TOKEN, { polling: true });
const HTML = { parse_mode: "HTML" };

// ---------------- per-user rate limiting ----------------
// Caps command throughput per Telegram user so the bot (and the backend it
// talks to) can't be hammered by a single account, compromised or not.
// Wrapping onText once here covers every /command registered below without
// having to touch each handler individually.
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

const originalOnText = bot.onText.bind(bot);
bot.onText = function rateLimitedOnText(regex, handler) {
  return originalOnText(regex, async (msg, match) => {
    const userId = String(msg.from?.id ?? msg.chat.id);
    if (isRateLimited(userId)) {
      return bot.sendMessage(msg.chat.id, "⏳ Slow down a little — you're sending commands faster than I can process them safely.");
    }
    return handler(msg, match);
  });
};

async function reply(msg, templateText, context) {
  const rewritten = await humanize(templateText, context);
  await bot.sendMessage(msg.chat.id, rewritten || templateText, HTML);
}

function requireAdmin(msg) {
  if (isAdmin(msg)) return true;
  bot.sendMessage(msg.chat.id, "🔒 That command changes live office state, so it's limited to admins (set ADMIN_CHAT_IDS in the bot's .env).");
  return false;
}

// ---------------- read-only ----------------

bot.onText(/^\/status$/, async (msg) => {
  const { devices } = await getSnapshot();
  await reply(msg, formatStatus(devices), "office-wide device status summary");
});

bot.onText(/^\/room(?:\s+(.+))?$/, async (msg, match) => {
  const roomId = resolveRoom(match[1]);
  if (!roomId) return bot.sendMessage(msg.chat.id, formatRoomNotFound(match[1], ROOM_IDS));
  try {
    const room = await getRoom(roomId);
    await reply(msg, formatRoom(roomId, room), `single-room status for ${roomId}`, HTML);
  } catch {
    await bot.sendMessage(msg.chat.id, formatRoomNotFound(match[1], ROOM_IDS));
  }
});

bot.onText(/^\/usage$/, async (msg) => {
  const [power, kwhToday] = await Promise.all([getPower(), getEstimatedKwhToday()]);
  await reply(msg, formatUsage(power.total, kwhToday, power.perRoom), "power usage summary");
});

bot.onText(/^\/rooms$/, async (msg) => {
  const { rooms } = await listRooms();
  await bot.sendMessage(msg.chat.id, formatRoomsList(rooms), HTML);
});

bot.onText(/^\/alerts$/, async (msg) => {
  const { alerts } = await getAlerts();
  await bot.sendMessage(msg.chat.id, formatAlerts(alerts), HTML);
});

bot.onText(/^\/cost$/, async (msg) => {
  const cost = await getCost();
  await bot.sendMessage(msg.chat.id, formatCost(cost), HTML);
});

bot.onText(/^\/weather$/, async (msg) => {
  const w = await getWeather().catch(() => null);
  await bot.sendMessage(msg.chat.id, formatWeather(w), HTML);
});

bot.onText(/^\/settings$/, async (msg) => {
  const s = await getSettings();
  await bot.sendMessage(msg.chat.id, formatSettings(s), HTML);
});

bot.onText(/^\/howto$/, async (msg) => {
  const s = await getSettings();
  await bot.sendMessage(msg.chat.id, formatHowTo(s.howToUse), HTML);
});

bot.onText(/^\/(help|start)$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    [
      "<b>Read-only (anyone):</b>",
      "/status — quick on/off summary for every room",
      "/room &lt;name&gt; — detail for one room",
      "/usage — total power + today's estimated kWh",
      "/rooms — list every room",
      "/alerts — active alerts",
      "/cost — today's estimated cost",
      "/weather — current weather + forecast",
      "/settings — current admin settings",
      "/howto — how-to video link + guidelines",
      "",
      "<b>Control (admins only):</b>",
      "/on /off — power the whole office on/off",
      "/device &lt;id&gt; &lt;on|off&gt;",
      "/auto &lt;room&gt; &lt;on|off&gt;",
      "/addroom &lt;name&gt; [fans] [lights] [acs] [computers]",
      "/removeroom &lt;room&gt;",
      "/setlocation &lt;lat&gt; &lt;lon&gt; [label]",
      "/sethowto &lt;youtubeUrl&gt; | &lt;guidelines text&gt;",
    ].join("\n"),
    HTML
  );
});

// ---------------- control ----------------

bot.onText(/^\/on$/, async (msg) => {
  if (!requireAdmin(msg)) return;
  const result = await setSystemPower(true, `telegram:${msg.from?.username || msg.from?.id}`);
  await reply(msg, formatSystemPower(result.enabled), "master power toggle");
});

bot.onText(/^\/off$/, async (msg) => {
  if (!requireAdmin(msg)) return;
  const result = await setSystemPower(false, `telegram:${msg.from?.username || msg.from?.id}`);
  await reply(msg, formatSystemPower(result.enabled), "master power toggle");
});

bot.onText(/^\/device\s+(\S+)\s+(on|off)$/i, async (msg, match) => {
  if (!requireAdmin(msg)) return;
  const [, deviceId, status] = match;
  await setDevice(deviceId, status.toLowerCase());
  await bot.sendMessage(msg.chat.id, `✅ <code>${deviceId}</code> is now <b>${status.toUpperCase()}</b>.`, HTML);
});

bot.onText(/^\/auto\s+(\S+)\s+(on|off)$/i, async (msg, match) => {
  if (!requireAdmin(msg)) return;
  const [, roomArg, stateRaw] = match;
  const roomId = resolveRoom(roomArg);
  await setRoomAuto(roomId, stateRaw.toLowerCase() === "on");
  await bot.sendMessage(msg.chat.id, `✅ Automation for <b>${roomId}</b> is now <b>${stateRaw.toUpperCase()}</b>.`, HTML);
});

bot.onText(/^\/addroom\s+(.+)$/, async (msg, match) => {
  if (!requireAdmin(msg)) return;
  const [name, fans, lights, acs, computers] = match[1].split(/\s+/);
  const room = await addRoom({
    name,
    fans: fans !== undefined ? Number(fans) : undefined,
    lights: lights !== undefined ? Number(lights) : undefined,
    acs: acs !== undefined ? Number(acs) : undefined,
    computers: computers !== undefined ? Number(computers) : undefined,
  });
  await bot.sendMessage(msg.chat.id, `✅ Room <b>${room.room.name}</b> (<code>${room.room.id}</code>) created.`, HTML);
});

bot.onText(/^\/removeroom\s+(\S+)$/, async (msg, match) => {
  if (!requireAdmin(msg)) return;
  const roomId = resolveRoom(match[1]);
  await removeRoom(roomId);
  await bot.sendMessage(msg.chat.id, `🗑️ Room <b>${roomId}</b> removed.`, HTML);
});

bot.onText(/^\/setlocation\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*(.*)$/, async (msg, match) => {
  if (!requireAdmin(msg)) return;
  const [, latRaw, lonRaw, label] = match;
  await setLocation(Number(latRaw), Number(lonRaw), label || undefined);
  await bot.sendMessage(msg.chat.id, `📍 Weather location updated to <b>${latRaw}, ${lonRaw}</b>${label ? ` (${label})` : ""}.`, HTML);
});

bot.onText(/^\/sethowto\s+(.+)$/, async (msg, match) => {
  if (!requireAdmin(msg)) return;
  const [urlPart, ...guidelineParts] = match[1].split("|");
  const youtubeUrl = urlPart.trim();
  const guidelines = guidelineParts.join("|").trim();
  await setHowToUse({ youtubeUrl, guidelines: guidelines || undefined });
  await bot.sendMessage(msg.chat.id, "✅ How-to video/guidelines updated.");
});

bot.on("polling_error", (err) => console.error("[soms-telegram-bot] polling error:", err.message));

// ---------------- bonus: proactive alert push ----------------

function connectAlertsSocket() {
  const chatId = process.env.ALERTS_CHAT_ID || "";
  if (!chatId) {
    console.warn("[soms-telegram-bot] ALERTS_CHAT_ID not set — proactive alert push disabled.");
    return;
  }
  const wsUrl = process.env.SOMS_WS_URL || "ws://localhost:4000/ws/live";
  const token = process.env.SOMS_AUTH_TOKEN || "";
  const ws = new WebSocket(token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl);

  ws.on("open", () => console.log("[soms-telegram-bot] connected to backend WS for proactive alerts"));
  ws.on("message", async (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (evt.event !== "alert:new" || !evt.payload) return;
    try {
      await bot.sendMessage(chatId, formatAlertPush(evt.payload));
    } catch (err) {
      console.error("[soms-telegram-bot] failed to post proactive alert:", err.message);
    }
  });
  ws.on("close", () => {
    console.warn("[soms-telegram-bot] backend WS closed — reconnecting in 5s");
    setTimeout(connectAlertsSocket, 5000);
  });
  ws.on("error", (err) => console.error("[soms-telegram-bot] backend WS error:", err.message));
}

console.log("[soms-telegram-bot] polling started.");
connectAlertsSocket();
