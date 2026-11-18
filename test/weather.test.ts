import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntervalsEvent } from "../src/intervals.ts";
import {
  type Forecast,
  checkRideWeather,
  dayVerdict,
  evaluateDay,
  isOutdoorDay,
  isWeatherCheckTime,
  isZ2,
  outdoorDays,
  outdoorRule,
  rideWeatherSection,
} from "../src/weather.ts";
import { makeEnv, makeFetch, makeKV } from "./helpers.ts";

const RULE = { minFeelsC: 5, maxWindKmh: 30, minHours: 3 };
const NOW = new Date("2026-11-05T18:00:00Z"); // Thursday, 19:00 in Brussels

interface Hour {
  feels?: number;
  wind?: number;
  rain?: number;
  chance?: number;
}

/** A forecast for these dates; `hours[date][h]` overrides the default (dry, 8 °C, 15 km/h). */
function forecast(dates: string[], hours: Record<string, Record<number, Hour>> = {}): Forecast {
  const f: Forecast = {
    hourly: { time: [], apparent_temperature: [], precipitation: [], precipitation_probability: [], wind_speed_10m: [] },
    daily: { time: dates, sunrise: dates.map((d) => `${d}T07:50`), sunset: dates.map((d) => `${d}T17:10`) },
  };
  for (const date of dates) {
    for (let h = 0; h < 24; h++) {
      const o = hours[date]?.[h] ?? {};
      f.hourly.time.push(`${date}T${String(h).padStart(2, "0")}:00`);
      f.hourly.apparent_temperature.push(o.feels ?? 8);
      f.hourly.wind_speed_10m.push(o.wind ?? 15);
      f.hourly.precipitation.push(o.rain ?? 0);
      f.hourly.precipitation_probability.push(o.chance ?? 10);
    }
  }
  return f;
}

const range = (from: number, to: number, value: Hour) =>
  Object.fromEntries(Array.from({ length: to - from }, (_, i) => [from + i, value]));

test("evaluateDay: whole daylight hours only (08:00–17:00 between sunrise 07:50 and sunset 17:10)", () => {
  const day = evaluateDay(forecast(["2026-11-07"]), "2026-11-07", RULE)!;
  assert.equal(day.ok, true);
  assert.deepEqual(day.window, { from: 8, to: 17 });
  assert.equal(day.daylightHours, 9);
  assert.equal(dayVerdict(day), "✅ outdoor 08:00–17:00 (9 h) · feels 8 to 8 °C · wind ≤ 15 km/h");
});

test("evaluateDay: a good day shows the conditions inside its window, not the whole day", () => {
  const f = forecast(["2026-11-07"], { "2026-11-07": { ...range(8, 11, { feels: 1, wind: 40 }), 16: { feels: 2 } } });
  const day = evaluateDay(f, "2026-11-07", RULE)!;
  assert.deepEqual(day.window, { from: 11, to: 16 });
  assert.equal(dayVerdict(day), "✅ outdoor 11:00–16:00 (5 h) · feels 8 to 8 °C · wind ≤ 15 km/h");
});

test("evaluateDay: rain, wind and cold each break the window; the longest stretch counts", () => {
  const f = forecast(["2026-11-07"], {
    "2026-11-07": { 10: { rain: 0.6 }, 11: { chance: 70 }, 14: { wind: 35 } },
  });
  const day = evaluateDay(f, "2026-11-07", RULE)!;
  assert.deepEqual(day.window, { from: 8, to: 10 }); // 08–10, 12–14, 15–17: all 2 h, first kept
  assert.equal(day.ok, false);
  assert.equal(day.rainHours, 2);
  assert.match(dayVerdict(day), /^🏠 indoor: rain in 2 of 9 daylight hours, wind up to 35 km\/h; best window/);
  assert.match(dayVerdict(day), /needs 3 h$/);

  const cold = evaluateDay(forecast(["2026-11-07"], { "2026-11-07": range(8, 17, { feels: 3 }) }), "2026-11-07", RULE)!;
  assert.equal(cold.ok, false);
  assert.equal(cold.window, undefined);
  assert.equal(dayVerdict(cold), "🏠 indoor: feels like 3 °C at the coldest");
});

test("evaluateDay: a long ride needs a long window; fromHour skips the past; unknown date", () => {
  const f = forecast(["2026-11-07"], { "2026-11-07": { 13: { rain: 1 } } }); // 08–13 and 14–17
  assert.equal(evaluateDay(f, "2026-11-07", RULE, 5)!.ok, true);
  assert.equal(evaluateDay(f, "2026-11-07", RULE, 6)!.ok, false);
  assert.deepEqual(evaluateDay(f, "2026-11-07", RULE, 3, 11)!.window, { from: 14, to: 17 });
  const late = evaluateDay(f, "2026-11-07", RULE, 3, 18)!;
  assert.equal(dayVerdict(late), "🏠 indoor: no daylight left");
  assert.equal(evaluateDay(f, "2026-11-20", RULE), undefined);
});

test("outdoorRule: vars override the defaults; blanks and junk fall back", () => {
  const env = makeEnv("k");
  assert.deepEqual(outdoorRule(env), RULE);
  assert.deepEqual(outdoorRule({ ...env, OUTDOOR_MIN_FEELS_C: "2", OUTDOOR_MAX_WIND_KMH: "", OUTDOOR_MIN_HOURS: "x" }), {
    ...RULE,
    minFeelsC: 2,
  });
});

test("isWeatherCheckTime: 06:30 and 19:00 Brussels, one cron tick each", () => {
  assert.equal(isWeatherCheckTime(new Date("2026-11-05T18:00:00Z")), true);
  assert.equal(isWeatherCheckTime(new Date("2026-11-05T05:34:00Z")), true);
  assert.equal(isWeatherCheckTime(new Date("2026-11-05T06:00:00Z")), false);
  assert.equal(isWeatherCheckTime(new Date("2026-11-05T18:05:00Z")), false);
  assert.equal(isWeatherCheckTime(new Date("2026-11-05T19:00:00Z")), false);
  assert.equal(isWeatherCheckTime(new Date("2026-06-05T17:00:00Z")), true); // summer time
  assert.equal(isWeatherCheckTime(new Date("2026-06-05T04:30:00Z")), true);
});

test("rideWeatherSection: one line per forecast day; today starts after the current hour", async () => {
  const dates = ["2026-11-05", "2026-11-06", "2026-11-07"];
  const { fetchImpl, calls } = makeFetch(() => Response.json(forecast(dates)));
  const text = await rideWeatherSection(makeEnv("k"), new Date("2026-11-05T12:30:00Z"), fetchImpl);
  assert.match(calls[0]!.url, /latitude=50\.85&longitude=4\.35/);
  assert.match(calls[0]!.url, /timezone=Europe%2FBrussels/);
  assert.equal(
    text,
    [
      "Outdoor rule: dry for 3 h or more in daylight, feels-like 5 °C or higher, wind under 30 km/h. Days 4–7 are less certain and are re-checked at 06:30 and 19:00.",
      'Outdoor rides: Z2 rides only, on Fri, Sat, Sun or days covered by a "Home week" note. Interval rides stay indoor; rides with 📌 are never switched.',
      "- Thu 05 Nov: ✅ outdoor 14:00–17:00 (3 h) · feels 8 to 8 °C · wind ≤ 15 km/h",
      "- Fri 06 Nov: ✅ outdoor 08:00–17:00 (9 h) · feels 8 to 8 °C · wind ≤ 15 km/h",
      "- Sat 07 Nov: ✅ outdoor 08:00–17:00 (9 h) · feels 8 to 8 °C · wind ≤ 15 km/h",
    ].join("\n"),
  );

  const failing = makeFetch(() => new Response("down", { status: 503 }));
  assert.match(await rideWeatherSection(makeEnv("k"), NOW, failing.fetchImpl), /^\(forecast unavailable: Open-Meteo HTTP 503/);
});

const outdoorSat: IntervalsEvent = {
  id: 21,
  start_date_local: "2026-11-07T00:00:00",
  category: "WORKOUT",
  type: "Ride",
  name: "Outdoor Z2",
  moving_time: 9000,
};
const indoorSun: IntervalsEvent = {
  id: 22,
  start_date_local: "2026-11-08T00:00:00",
  category: "WORKOUT",
  type: "VirtualRide",
  name: "Ride — Aerobic Foundation 90m (Z2)",
  moving_time: 5400,
  indoor: true,
};
const run: IntervalsEvent = { id: 23, start_date_local: "2026-11-06T00:00:00", category: "WORKOUT", type: "Run" };
const DATES = ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"];

function setup(f: Forecast, events: IntervalsEvent[], kvInitial: Record<string, string> = {}, fire = true) {
  const { kv, data } = makeKV(kvInitial);
  const env = { ...makeEnv("k"), STATE: kv, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x", COACH_CHANNEL_ID: "chan-1" };
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.includes("intervals.icu")) return Response.json(events);
    if (call.url.includes("open-meteo.com")) return Response.json(f);
    if (call.url.includes("/channels/chan-1/messages")) return Response.json([]);
    if (call.url.includes("anthropic.com")) {
      return fire
        ? Response.json({ claude_code_session_url: "https://claude.ai/code/s" })
        : Response.json({ error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 });
    }
    return new Response("{}");
  });
  return { env, data, fetchImpl, calls };
}

test("checkRideWeather: nothing posted when the plan matches the forecast", async () => {
  const wet = forecast(DATES, { "2026-11-08": range(8, 17, { rain: 2 }) });
  const { env, fetchImpl, calls } = setup(wet, [outdoorSat, indoorSun, run]);
  assert.equal(await checkRideWeather(env, NOW, fetchImpl), 0);
  assert.equal(calls.filter((c) => c.url.includes("anthropic") || c.url.includes("webhooks")).length, 0);
  assert.match(calls[0]!.url, /events\?oldest=2026-10-23&newest=2026-11-08/, "evening: today skipped; 2 weeks back for notes");
});

test("checkRideWeather: flips start the coach once, with a notice in #coach", async () => {
  // Saturday turns windy (outdoor no longer fits), Sunday is dry (the indoor ride could go out).
  const f = forecast(DATES, { "2026-11-07": range(8, 17, { wind: 40 }) });
  const { env, data, fetchImpl, calls } = setup(f, [outdoorSat, indoorSun, run]);
  assert.equal(await checkRideWeather(env, NOW, fetchImpl), 2);

  const fire = calls.find((c) => c.url.includes("anthropic.com"))!;
  const text = JSON.parse(fire.body!).text as string;
  assert.match(text, /From: the Worker's automated weather check/);
  assert.match(text, /=== Automated weather check \(this is the request\) ===/);
  assert.match(text, /Sat 07 Nov · Outdoor Z2 · 2h30 \(planned outdoor\): now 🏠 indoor: wind up to 40 km\/h/);
  assert.match(text, /Sun 08 Nov · Ride — Aerobic Foundation 90m \(Z2\) · 1h30 \(planned indoor\): now ✅ outdoor 08:00–17:00/);
  assert.match(text, /Switch each one now, on the same day, without waiting for a confirmation/);
  assert.match(text, /=== Ride weather, next 7 days/);

  const notice = JSON.parse(calls.find((c) => c.url.includes("webhooks"))!.body!);
  assert.equal(notice.username, "Weather");
  assert.match(notice.content, /^🌦️ \*\*Forecast changed: switching a planned ride\*\*/);
  assert.match(notice.content, /\[Cloud session\]\(<https:\/\/claude\.ai\/code\/s>\)/);
  assert.equal(data.get("weather:21"), "indoor");
  assert.equal(data.get("weather:22"), "outdoor");
  assert.deepEqual(JSON.parse(data.get(`pending:weather-check-${NOW.getTime()}`)!), {
    channelId: "chan-1",
    message: "🌦️ Weather switch (Sat 07 Nov, Sun 08 Nov)",
    firedAt: NOW.getTime(),
    sessionUrl: "https://claude.ai/code/s",
  });

  // Same forecast at the next check: already flagged, nothing new.
  const again = setup(f, [outdoorSat, indoorSun, run], Object.fromEntries(data));
  assert.equal(await checkRideWeather(again.env, NOW, again.fetchImpl), 0);
  assert.equal(again.calls.filter((c) => c.url.includes("anthropic")).length, 0);
});

test("checkRideWeather: back in line clears the flag; a failed start is retried next time", async () => {
  const dry = setup(forecast(DATES), [outdoorSat], { "weather:21": "indoor" });
  assert.equal(await checkRideWeather(dry.env, NOW, dry.fetchImpl), 0);
  assert.equal(dry.data.has("weather:21"), false);

  const wet = forecast(DATES, { "2026-11-07": range(8, 17, { rain: 1 }) });
  const failed = setup(wet, [outdoorSat], {}, false);
  assert.equal(await checkRideWeather(failed.env, NOW, failed.fetchImpl), 0);
  assert.equal(failed.data.has("weather:21"), false);
  const notice = JSON.parse(failed.calls.find((c) => c.url.includes("webhooks"))!.body!);
  assert.match(notice.content, /⚠️ Couldn't start the coach \(rate_limit_error: slow down\)/);
});

test("checkRideWeather: done rides and runs are ignored; the morning check includes today", async () => {
  const wet = forecast(DATES, range(0, 0, {}));
  const done = { ...outdoorSat, start_date_local: "2026-11-05T00:00:00", paired_activity_id: "i1" };
  const { env, fetchImpl, calls } = setup(wet, [done, run]);
  assert.equal(await checkRideWeather(env, new Date("2026-11-05T06:00:00Z"), fetchImpl), 0);
  assert.match(calls[0]!.url, /oldest=2026-10-22&newest=2026-11-08/);
  assert.equal(calls.some((c) => c.url.includes("open-meteo")), false, "no rides: no forecast needed");
});

test("checkRideWeather: interval rides, 📌 rides and off-days stay indoor, unless a Home week note covers the day", async () => {
  const sweetSpot: IntervalsEvent = { ...indoorSun, id: 31, name: "Ride — Sweet Spot 3×10 (75m) — quality" };
  const fridayZ2: IntervalsEvent = { ...indoorSun, id: 32, start_date_local: "2026-11-06T00:00:00", name: "Ride — Z2 60m" };
  const dry = forecast(DATES);
  const pinned: IntervalsEvent = { ...indoorSun, id: 33, name: "Ride — Aerobic Foundation 90m (Z2) 📌" };
  const plain = setup(dry, [sweetSpot, pinned]);
  assert.equal(await checkRideWeather(plain.env, NOW, plain.fetchImpl), 0);

  // Friday is an outdoor day by default; with OUTDOOR_DAYS "sat,sun" it isn't …
  const weekendOnly = setup(dry, [fridayZ2]);
  assert.equal(await checkRideWeather({ ...weekendOnly.env, OUTDOOR_DAYS: "sat,sun" }, NOW, weekendOnly.fetchImpl), 0);
  // … unless a "Home week" note covers it.
  const homeWeek: IntervalsEvent = {
    id: 40,
    category: "NOTE",
    name: "Home week",
    start_date_local: "2026-11-02T00:00:00",
    end_date_local: "2026-11-09T00:00:00",
  };
  const home = setup(dry, [homeWeek, fridayZ2]);
  assert.equal(await checkRideWeather({ ...home.env, OUTDOOR_DAYS: "sat,sun" }, NOW, home.fetchImpl), 1);
});

test("outdoorDays, isOutdoorDay and isZ2", () => {
  const env = { ...makeEnv("k"), OUTDOOR_DAYS: "sun, Saturday" };
  assert.deepEqual(outdoorDays(env), ["sat", "sun"]);
  assert.equal(isOutdoorDay(env, "2026-11-07", []), true);
  assert.equal(isOutdoorDay(env, "2026-11-06", []), false);
  const note: IntervalsEvent = {
    id: 1,
    category: "NOTE",
    name: "home week",
    start_date_local: "2026-11-04T00:00:00",
    end_date_local: "2026-11-06T00:00:00",
  };
  assert.equal(isOutdoorDay(env, "2026-11-05", [note]), true);
  assert.equal(isOutdoorDay(env, "2026-11-06", [note]), false, "end date is exclusive");
  assert.equal(isOutdoorDay(env, "2026-11-05", [{ ...note, category: "WORKOUT" }]), false);
  const named = (name: string): IntervalsEvent => ({ id: 1, category: "WORKOUT", start_date_local: "", name });
  assert.equal(isZ2(named("Ride — Steady Endurance 2h (Z2) ⭐ priority")), true);
  assert.equal(isZ2(named("Ride — Sweet Spot 3×10 (75m) — quality")), false);
});
