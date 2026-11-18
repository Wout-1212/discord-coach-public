import { IntervalsError, type IntervalsEvent, brusselsDate, listEvents } from "./intervals.ts";
import type { Env, InteractionOption } from "./types.ts";

/**
 * `/plan [day]`: what's on the Intervals calendar, read straight from the API.
 * No Claude run, so it answers in a second and costs no usage. Questions about
 * the plan ("should I swap these?") still go to /coach.
 */

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SHOWN = new Set(["WORKOUT", "RACE_A", "RACE_B", "RACE_C", "NOTE", "HOLIDAY", "SICK", "INJURED"]);
const DAY_MS = 86_400_000;

export function readPlanDay(options: InteractionOption[] = []): string {
  const value = options.find((o) => o.name === "day")?.value;
  return typeof value === "string" && value ? value : "today";
}

/**
 * The local dates (YYYY-MM-DD) for a `day` value: "today", "tomorrow", "week" (7 days from
 * today) or "mon"…"sun" (the next one, today included).
 */
export function planDates(day: string, now: Date): string[] {
  const today = new Date(`${brusselsDate.format(now)}T00:00:00Z`);
  const at = (offset: number) => new Date(today.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
  if (day === "week") return Array.from({ length: 7 }, (_, i) => at(i));
  if (day === "tomorrow") return [at(1)];
  const weekday = WEEKDAYS.indexOf(day);
  if (weekday !== -1) return [at((weekday - today.getUTCDay() + 7) % 7)];
  return [at(0)];
}

/** 5400 → "1h30", 7200 → "2h", 1950 → "33 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)}h${rest ? String(rest).padStart(2, "0") : ""}`;
}

export function sportEmoji(type: string | null | undefined, category = "WORKOUT"): string {
  if (category.startsWith("RACE")) return "🏁";
  if (category === "NOTE") return "📝";
  if (category !== "WORKOUT") return "🛑"; // holiday, sick, injured
  if (!type) return "•";
  if (type.includes("Ride")) return "🚴";
  if (type.includes("Run")) return "🏃";
  if (type === "WeightTraining") return "🏋️";
  if (type === "Walk" || type === "Hike") return "🚶";
  if (type.includes("Swim")) return "🏊";
  return "•";
}

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "2-digit",
  month: "short",
});

function dayLabel(date: string, dates: { today: string; tomorrow: string }): string {
  const label = dayFormat.format(new Date(`${date}T00:00:00Z`));
  if (date === dates.today) return `Today · ${label}`;
  if (date === dates.tomorrow) return `Tomorrow · ${label}`;
  return label;
}

function eventLine(e: IntervalsEvent): string {
  const parts = [`${sportEmoji(e.type, e.category)} ${e.name || e.category.toLowerCase()}`];
  if (e.category === "WORKOUT") {
    if (e.moving_time) parts.push(formatDuration(e.moving_time));
    if (e.icu_training_load) parts.push(`${Math.round(e.icu_training_load)} load`);
    if (e.indoor) parts.push("indoor");
  }
  return parts.join(" · ") + (e.paired_activity_id ? " ✅" : "");
}

/** The plan as a Discord message. */
export function formatPlan(events: IntervalsEvent[], dates: string[], now: Date): string {
  const [today = "", tomorrow = ""] = planDates("week", now);
  const shown = events.filter(
    (e) => SHOWN.has(e.category) && dates.includes(e.start_date_local.slice(0, 10)),
  );
  const blocks = dates.map((date) => {
    const lines = shown.filter((e) => e.start_date_local.startsWith(date)).map(eventLine);
    const body = lines.length ? lines.join("\n") : dates.length === 1 ? "Nothing planned: rest day." : "Rest";
    return `**${dayLabel(date, { today, tomorrow })}**\n${body}`;
  });

  if (dates.length > 1) {
    const workouts = shown.filter((e) => e.category === "WORKOUT");
    const time = workouts.reduce((sum, e) => sum + (e.moving_time ?? 0), 0);
    const load = workouts.reduce((sum, e) => sum + (e.icu_training_load ?? 0), 0);
    blocks.push(`Total: ${formatDuration(time)} · ${Math.round(load)} load`);
  }
  return `📅 ${blocks.join("\n\n")}\n-# ✅ = done. Changes or advice: \`/coach\``;
}

/** Read the calendar and return the message to show in Discord. Never throws. */
export async function showPlan(
  env: Env,
  day: string,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const dates = planDates(day, now);
  try {
    // One day extra in case `newest` is exclusive; formatPlan keeps only the asked dates.
    const dayAfter = new Date(Date.parse(`${dates.at(-1)}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    const events = await listEvents(env, dates[0]!, dayAfter, fetchImpl);
    return formatPlan(events, dates, now);
  } catch (err) {
    console.error("plan failed:", (err as Error).message);
    if (err instanceof IntervalsError && (err.status === 401 || err.status === 403)) {
      return "⚠️ Intervals rejected the API key. Set it with `npx wrangler secret put INTERVALS_API_KEY`.";
    }
    return `⚠️ Couldn't read the calendar (${(err as Error).message}). Try again in a minute, or ask \`/coach\`.`;
  }
}
