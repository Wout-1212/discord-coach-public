import { IntervalsError, type IntervalsWellness, brusselsDate, listWellness } from "./intervals.ts";
import { formatDuration } from "./plan.ts";
import type { Env } from "./types.ts";
import { dayName, rideWeatherSection } from "./weather.ts";

/**
 * `/status`: load, last night's recovery and the ride weather, read straight from Intervals
 * and Open-Meteo. No Claude run, so it answers in a second and costs no usage.
 */

const BASELINE_DAYS = 7;
const DAY_MS = 86_400_000;

/** Average of a field over the days before today; undefined when there's no data. */
function baseline(days: IntervalsWellness[], field: "hrv" | "restingHR"): number | undefined {
  const values = days.map((d) => d[field]).filter((v): v is number => typeof v === "number");
  return values.length ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length) : undefined;
}

function withBaseline(label: string, value: number, average: number | undefined): string {
  return `${label} ${Math.round(value)}${average === undefined ? "" : ` (7-day avg ${average})`}`;
}

function loadLine(days: IntervalsWellness[]): string {
  const latest = [...days].reverse().find((d) => typeof d.ctl === "number" && typeof d.atl === "number");
  if (!latest) return "**Load:** no data";
  const form = Math.round(latest.ctl! - latest.atl!);
  return `**Load:** fitness (CTL) ${Math.round(latest.ctl!)} · fatigue (ATL) ${Math.round(latest.atl!)} · form ${form > 0 ? "+" : ""}${form}`;
}

function recoveryLine(today: IntervalsWellness | undefined, before: IntervalsWellness[]): string {
  const parts: string[] = [];
  if (today?.sleepSecs) {
    parts.push(`sleep ${formatDuration(today.sleepSecs)}${today.sleepScore ? ` (score ${Math.round(today.sleepScore)})` : ""}`);
  }
  if (today?.hrv) parts.push(withBaseline("HRV", today.hrv, baseline(before, "hrv")));
  if (today?.restingHR) parts.push(withBaseline("resting HR", today.restingHR, baseline(before, "restingHR")));
  return parts.length ? `**Last night:** ${parts.join(" · ")}` : "**Last night:** no Garmin data yet";
}

/** The status as a Discord message. `weather` is the ride weather block (weather.ts). */
export function formatStatus(days: IntervalsWellness[], weather: string, now: Date): string {
  const date = brusselsDate.format(now);
  const before = days.filter((d) => d.id < date);
  const forecast = weather.split("\n").filter((line) => line.startsWith("- "));
  return [
    `📊 **Status · ${dayName(date)}**`,
    loadLine(days),
    recoveryLine(days.find((d) => d.id === date), before),
    "",
    "**Ride weather**",
    ...(forecast.length ? forecast : ["Forecast unavailable."]),
    "-# Calendar: `/plan`. Advice: `/coach`",
  ].join("\n");
}

/** Read the data and return the message to show in Discord. Never throws. */
export async function showStatus(env: Env, now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const oldest = brusselsDate.format(new Date(now.getTime() - BASELINE_DAYS * DAY_MS));
    const [days, weather] = await Promise.all([
      listWellness(env, oldest, brusselsDate.format(now), fetchImpl),
      rideWeatherSection(env, now, fetchImpl),
    ]);
    return formatStatus(days, weather, now);
  } catch (err) {
    console.error("status failed:", (err as Error).message);
    if (err instanceof IntervalsError && (err.status === 401 || err.status === 403)) {
      return "⚠️ Intervals rejected the API key. Set it with `npx wrangler secret put INTERVALS_API_KEY`.";
    }
    return `⚠️ Couldn't read your status (${(err as Error).message}). Try again in a minute, or ask \`/coach\`.`;
  }
}
