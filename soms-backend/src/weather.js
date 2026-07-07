// Live weather from Open-Meteo, free and keyless

import { state } from "./state.js";

const WEATHER_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Rain", 65: "Heavy rain",
  71: "Slight snow", 73: "Snow", 75: "Heavy snow",
  80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ heavy hail",
};

// Best-effort reverse-geocode for display only
export async function reverseGeocode(lat, lon) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data?.results?.[0];
    if (!hit) return null;
    return [hit.name, hit.admin1, hit.country].filter(Boolean).slice(0, 2).join(", ");
  } catch {
    return null;
  }
}

export async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day` +
    `&hourly=temperature_2m,weather_code,precipitation_probability` +
    `&forecast_days=2&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo responded ${res.status}`);
  const data = await res.json();
  const c = data.current || {};

  // Build an hourly forecast strip
  const hourly = data.hourly || {};
  const times = hourly.time || [];
  const nowIdx = Math.max(
    0,
    times.findIndex((t) => new Date(t).getTime() >= Date.now())
  );
  const hourlyForecast = times.slice(nowIdx, nowIdx + 6).map((t, i) => {
    const idx = nowIdx + i;
    return {
      time: t,
      temperatureC: hourly.temperature_2m?.[idx],
      precipitationPct: hourly.precipitation_probability?.[idx] ?? 0,
      weatherCode: hourly.weather_code?.[idx],
      conditionLabel: WEATHER_CODES[hourly.weather_code?.[idx]] || "Unknown",
    };
  });

  const label = await reverseGeocode(lat, lon);

  return {
    lat, lon,
    label,
    temperatureC: c.temperature_2m,
    apparentTemperatureC: c.apparent_temperature,
    humidityPct: c.relative_humidity_2m,
    windSpeedKmh: c.wind_speed_10m,
    isDay: !!c.is_day,
    weatherCode: c.weather_code,
    conditionLabel: WEATHER_CODES[c.weather_code] || "Unknown",
    precipitationPct: hourlyForecast[0]?.precipitationPct ?? 0,
    hourly: hourlyForecast,
    timezone: data.timezone,
    fetchedAt: new Date().toISOString(),
  };
}

let pollHandle = null;

export function startWeatherPolling({ intervalMs = 10 * 60 * 1000 } = {}) {
  if (pollHandle) return;
  const tick = async () => {
    const loc = state.settings.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") return;
    try {
      state.weather = await fetchWeather(loc.lat, loc.lon);
    } catch (err) {
      console.warn("[weather] poll failed:", err.message);
    }
  };
  tick(); // fire immediately if a location is already saved
  pollHandle = setInterval(tick, intervalMs);
}

export function stopWeatherPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}
