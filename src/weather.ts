import { dispatchAutomated } from "./automated.ts";
import { explainFireError } from "./claude.ts";
import { postWebhook } from "./discord.ts";
import { type IntervalsEvent, addDays, brusselsDate, listEvents } from "./intervals.ts";
import { formatDuration } from "./plan.ts";
import { inHomeWeek } from "./plan-check.ts";
import type { Env } from "./types.ts";
import { sessionLine } from "./watchdog.ts";

/**
 * Outdoor ride weather. The Worker reads the Open-Meteo forecast (free, no key) for where
 * Wout rides and applies the outdoor rule in code, so the coach doesn't have to guess:
 *  - every coach run gets a 7-day "ride weather" block in its input (rideWeatherSection);
 *  - at 06:30 (before the Morning brief) and 19:00 the cron compares the rides planned for the next days with the
 *    forecast. When an outdoor ride no longer fits, or an indoor Z2 ride on an outdoor day
 *    has a good window, it starts the coach task to switch it right away (no ✅ needed).
 *    Each switch is asked once (remembered in KV); runs are always outdoor and aren't checked.
 *
 * Outdoor days: OUTDOOR_DAYS (Fri–Sun), plus days covered by a calendar note with
 * "Home week" in its name. Interval rides always stay indoor.
 */

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const FORECAST_DAYS = 7;
const CHECK_TIMES = ["06:30", "19:00"]; // Europe/Brussels; 06:30 so the Morning brief sees the switch
const LOOKAHEAD_DAYS = 3; // forecasts further out change too much to act on
const FLAG_TTL_S = 7 * 86_400;
// An hour counts as dry below this much rain and this chance of rain.
const DRY_MM = 0.2;
const DRY_MAX_PROBABILITY = 40;

export interface Forecast {
  hourly: {
    time: string[]; // local, 2026-11-07T10:00
    apparent_temperature: number[];
    precipitation: number[];
    precipitation_probability: (number | null)[];
    wind_speed_10m: number[];
  };
  daily: { time: string[]; sunrise: string[]; sunset: string[] };
}

export interface OutdoorRule {
  minFeelsC: number;
  maxWindKmh: number;
  minHours: number;
}

export interface RideDay {
  date: string;
  ok: boolean;
  needHours: number;
  /** Longest stretch of good daylight hours, local hours [from, to). */
  window?: { from: number; to: number };
  daylightHours: number;
  rainHours: number;
  feels?: { min: number; max: number };
  maxWind?: number;
  reasons: string[];
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value?.trim() && Number.isFinite(n) ? n : fallback;
}

export function outdoorRule(env: Env): OutdoorRule {
  return {
    minFeelsC: num(env.OUTDOOR_MIN_FEELS_C, 5),
    maxWindKmh: num(env.OUTDOOR_MAX_WIND_KMH, 30),
    minHours: num(env.OUTDOOR_MIN_HOURS, 3),
  };
}

export function ruleText(rule: OutdoorRule): string {
  return `dry for ${rule.minHours} h or more in daylight, feels-like ${rule.minFeelsC} °C or higher, wind under ${rule.maxWindKmh} km/h`;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** OUTDOOR_DAYS ("fri,sat,sun") as weekday names, Monday first. */
export function outdoorDays(env: Env): string[] {
  const set = (env.OUTDOOR_DAYS ?? "fri,sat,sun").toLowerCase().split(",").map((d) => d.trim().slice(0, 3));
  return [...WEEKDAYS.slice(1), WEEKDAYS[0]!].filter((d) => set.includes(d));
}

/** May an indoor ride on `date` go outdoors: an OUTDOOR_DAYS weekday, or inside a "Home week" note. */
export function isOutdoorDay(env: Env, date: string, events: IntervalsEvent[]): boolean {
  if (outdoorDays(env).includes(WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!)) return true;
  return inHomeWeek(date, events);
}

/** Wout chose indoor/outdoor himself: the coach adds 📌 to the name, and the forecast leaves it alone. */
export function isPinned(e: IntervalsEvent): boolean {
  return (e.name ?? "").includes("📌");
}

/** Z2 rides carry "Z2" in their name (the coach names them that way); intervals don't. */
export function isZ2(e: IntervalsEvent): boolean {
  return /\bZ2\b/i.test(e.name ?? "");
}

export async function fetchForecast(env: Env, fetchImpl: typeof fetch = fetch): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: String(num(env.WEATHER_LAT, 50.85)), // default: Brussels
    longitude: String(num(env.WEATHER_LON, 4.35)),
    hourly: "apparent_temperature,precipitation,precipitation_probability,wind_speed_10m",
    daily: "sunrise,sunset",
    timezone: "Europe/Brussels",
    forecast_days: String(FORECAST_DAYS),
  });
  const res = await fetchImpl(`${OPEN_METEO}?${params}`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Forecast;
}

/** "2026-11-07T07:51" → 7.85 */
function hourOf(time: string): number {
  return Number(time.slice(11, 13)) + Number(time.slice(14, 16)) / 60;
}

/**
 * Can `date` be an outdoor ride day? Only whole daylight hours count (from sunrise, back
 * before sunset), from `fromHour` on. Undefined when the forecast doesn't cover the date.
 */
export function evaluateDay(
  f: Forecast,
  date: string,
  rule: OutdoorRule,
  needHours = rule.minHours,
  fromHour = 0,
): RideDay | undefined {
  const d = f.daily.time.indexOf(date);
  if (d === -1) return undefined;
  const first = Math.max(Math.ceil(hourOf(f.daily.sunrise[d]!)), fromHour);
  const last = Math.floor(hourOf(f.daily.sunset[d]!));

  const hours: { hour: number; feels: number; wind: number; wet: boolean }[] = [];
  f.hourly.time.forEach((time, i) => {
    const hour = Number(time.slice(11, 13));
    if (!time.startsWith(date) || hour < first || hour + 1 > last) return;
    hours.push({
      hour,
      feels: f.hourly.apparent_temperature[i]!,
      wind: f.hourly.wind_speed_10m[i]!,
      wet: f.hourly.precipitation[i]! >= DRY_MM || (f.hourly.precipitation_probability[i] ?? 0) > DRY_MAX_PROBABILITY,
    });
  });

  // Longest run of consecutive good hours; on a tie the earliest wins.
  let window: RideDay["window"];
  let run: { from: number; to: number } | undefined;
  for (const h of hours) {
    const good = !h.wet && h.feels >= rule.minFeelsC && h.wind < rule.maxWindKmh;
    if (!good) {
      run = undefined;
      continue;
    }
    run = run?.to === h.hour ? { from: run.from, to: h.hour + 1 } : { from: h.hour, to: h.hour + 1 };
    if (!window || run.to - run.from > window.to - window.from) window = run;
  }

  const length = window ? window.to - window.from : 0;
  const day: RideDay = {
    date,
    ok: length >= needHours,
    needHours,
    window,
    daylightHours: hours.length,
    rainHours: hours.filter((h) => h.wet).length,
    reasons: [],
  };
  // A good day shows the conditions inside its window; a bad one the whole day, to explain why.
  const shown = day.ok && window ? hours.filter((h) => h.hour >= window!.from && h.hour < window!.to) : hours;
  if (shown.length) {
    const feels = shown.map((h) => Math.round(h.feels));
    day.feels = { min: Math.min(...feels), max: Math.max(...feels) };
    day.maxWind = Math.round(Math.max(...shown.map((h) => h.wind)));
  }
  if (!day.ok) {
    if (!hours.length) day.reasons.push("no daylight left");
    if (day.rainHours) day.reasons.push(`rain in ${day.rainHours} of ${hours.length} daylight hours`);
    if (day.maxWind !== undefined && day.maxWind >= rule.maxWindKmh) day.reasons.push(`wind up to ${day.maxWind} km/h`);
    if (day.feels && day.feels.min < rule.minFeelsC) day.reasons.push(`feels like ${day.feels.min} °C at the coldest`);
  }
  return day;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short" });

export function dayName(date: string): string {
  return dayFormat.format(new Date(`${date}T00:00:00Z`));
}

const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** "✅ outdoor 10:00–15:00 (5 h) · feels 4–9 °C · wind ≤ 22 km/h" or "🏠 indoor: rain in 6 of 9 daylight hours …" */
export function dayVerdict(day: RideDay): string {
  const length = day.window ? day.window.to - day.window.from : 0;
  const window = day.window ? `${hh(day.window.from)}–${hh(day.window.to)} (${length} h)` : "";
  const conditions = day.feels ? ` · feels ${day.feels.min} to ${day.feels.max} °C · wind ≤ ${day.maxWind} km/h` : "";
  if (day.ok) return `✅ outdoor ${window}${conditions}`;
  const best = length ? `; best window ${window}, needs ${day.needHours} h` : "";
  return `🏠 indoor: ${day.reasons.join(", ") || "no window long enough"}${best}`;
}

const brusselsHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hourCycle: "h23" });

/** The "ride weather" block for the coach's run input. Never throws. */
export async function rideWeatherSection(env: Env, now: Date, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const forecast = await fetchForecast(env, fetchImpl);
    const rule = outdoorRule(env);
    const today = brusselsDate.format(now);
    const lines = forecast.daily.time.map((date) => {
      const day = evaluateDay(forecast, date, rule, rule.minHours, date === today ? Number(brusselsHour.format(now)) + 1 : 0);
      return `- ${dayName(date)}: ${day ? dayVerdict(day) : "no forecast"}`;
    });
    const days = outdoorDays(env).map((d) => d[0]!.toUpperCase() + d.slice(1));
    return [
      `Outdoor rule: ${ruleText(rule)}. Days 4–7 are less certain and are re-checked at 06:30 and 19:00.`,
      `Outdoor rides: Z2 rides only, on ${days.join(", ") || "no regular days"} or days covered by a "Home week" note. Interval rides stay indoor; rides with 📌 are never switched.`,
      ...lines,
    ].join("\n");
  } catch (err) {
    console.error("forecast failed:", (err as Error).message);
    return `(forecast unavailable: ${(err as Error).message})`;
  }
}

export function plannedAs(e: IntervalsEvent): "indoor" | "outdoor" {
  return e.indoor || e.type === "VirtualRide" ? "indoor" : "outdoor";
}

export function isWeatherCheckTime(now: Date): boolean {
  // Brussels is a whole number of hours off UTC, so the minutes match. The cron ticks every 5 min.
  const minute = now.getUTCMinutes() - (now.getUTCMinutes() % 5);
  return CHECK_TIMES.includes(`${brusselsHour.format(now)}:${String(minute).padStart(2, "0")}`);
}

interface Change {
  event: IntervalsEvent;
  planned: "indoor" | "outdoor";
  day: RideDay;
}

function changeLine(c: Change): string {
  const ride = [c.event.name || "Ride", c.event.moving_time ? formatDuration(c.event.moving_time) : ""].filter(Boolean).join(" · ");
  return `- ${dayName(c.day.date)} · ${ride} (planned ${c.planned}): now ${dayVerdict(c.day)}`;
}

export function weatherRequest(changes: Change[]): string {
  return [
    "The forecast no longer matches these planned rides:",
    ...changes.map(changeLine),
    "",
    "Switch each one now, on the same day, without waiting for a confirmation (see WEATHER): an outdoor ride " +
      "that no longer fits becomes an indoor ride (max 2 h); an indoor Z2 ride with a good window becomes an " +
      "outdoor Z2 ride that fits the window. Change nothing else, then report what you switched.",
  ].join("\n");
}

/**
 * Called from the cron at the CHECK_TIMES. Returns how many rides were sent to be switched.
 * Today is only checked in the morning; later, an unridden ride today is left alone.
 */
export async function checkRideWeather(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!env.STATE || !env.INTERVALS_API_KEY || !env.DISCORD_WEBHOOK_URL) return 0;
  const hour = Number(brusselsHour.format(now));
  const today = brusselsDate.format(now);
  const dates = Array.from({ length: LOOKAHEAD_DAYS + 1 }, (_, i) => addDays(today, i)).filter(
    (date) => date !== today || hour < 12,
  );

  // From two weeks back, so a "Home week" note that started earlier is included.
  const events = await listEvents(env, addDays(dates[0]!, -14), dates.at(-1)!, fetchImpl);
  const rides = events.filter(
    (e) =>
      e.category === "WORKOUT" &&
      e.type?.includes("Ride") &&
      !e.paired_activity_id &&
      !isPinned(e) &&
      dates.includes(e.start_date_local.slice(0, 10)),
  );
  if (!rides.length) return 0;

  const forecast = await fetchForecast(env, fetchImpl);
  const rule = outdoorRule(env);
  const changes: Change[] = [];
  for (const event of rides) {
    const date = event.start_date_local.slice(0, 10);
    const needHours = Math.max(rule.minHours, Math.ceil((event.moving_time ?? 0) / 3600));
    const day = evaluateDay(forecast, date, rule, needHours, date === today ? hour + 1 : 0);
    if (!day) continue;
    const planned = plannedAs(event);
    // A bad forecast sends any outdoor ride inside; only Z2 rides on outdoor days go out.
    const mayGoOut = planned === "outdoor" || (isZ2(event) && isOutdoorDay(env, date, events));
    const fits = day.ok && mayGoOut ? "outdoor" : "indoor";
    const key = `weather:${event.id}`;
    if (fits === planned) {
      // Back in line with the plan: a later flip is news again.
      if (await env.STATE.get(key)) await env.STATE.delete(key);
      continue;
    }
    if ((await env.STATE.get(key)) === fits) continue;
    changes.push({ event, planned, day });
  }
  if (!changes.length) return 0;

  const result = await dispatchAutomated(
    env,
    {
      kind: "weather check",
      request: weatherRequest(changes),
      weather: await rideWeatherSection(env, now, fetchImpl),
      now,
      notice: `🌦️ Weather switch (${changes.map((c) => dayName(c.day.date)).join(", ")})`,
    },
    fetchImpl,
  );

  const lines = ["🌦️ **Forecast changed: switching a planned ride**", ...changes.map(changeLine)];
  if (result.ok) {
    lines.push("🧠 _Coach is switching it (about a minute)._");
    if (result.sessionUrl) lines.push(sessionLine(result.sessionUrl));
    for (const c of changes) {
      await env.STATE.put(`weather:${c.event.id}`, c.day.ok ? "outdoor" : "indoor", { expirationTtl: FLAG_TTL_S });
    }
  } else {
    // Not remembered, so the next check tries again.
    lines.push(`⚠️ Couldn't start the coach (${result.error}). ${explainFireError(result)}`);
  }
  await postWebhook(env, { username: "Weather", content: lines.join("\n") }, fetchImpl);
  return result.ok ? changes.length : 0;
}
