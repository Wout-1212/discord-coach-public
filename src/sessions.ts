import { addDays } from "./intervals.ts";

/** Small shared helpers for activities and planned events (history, ladder, plan check, plan vs actual). */

export const SPIKE_FACTOR = 1.1; // Frandsen et al. 2025: a session vs the longest of the last 30 days
export const RUN_WINDOW_DAYS = 30;

// Names, because intensity can't tell these apart: a sweet spot session with its warm-up and
// recoveries averages about the same as a Z2 ride.
export const STEADY_NAME = /\bZ2\b|endurance|foundation/i;
export const HARD_NAME = /quality|sweet|threshold|vo2|tempo|race/i;

export type Sport = "run" | "ride" | "strength" | "other";

export function sportOf(item: { type?: string | null; name?: string | null }): Sport {
  const type = item.type ?? "";
  if (type.includes("Run")) return "run";
  if (type.includes("Ride")) return "ride";
  if (type === "WeightTraining" || /\bstrength\b/i.test(item.name ?? "")) return "strength";
  return "other";
}

export const dayOf = (item: { start_date_local: string }) => item.start_date_local.slice(0, 10);

/** 0 = Sunday … 6 = Saturday, for a local date. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The Monday of a local date's Mon–Sun week. */
export const weekStart = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** 2384 → "39:44" */
export function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const shortFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
/** "2026-11-09" → "9 Nov" */
export const shortDate = (date: string) => shortFormat.format(new Date(`${date.slice(0, 10)}T00:00:00Z`));

const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
/** "2026-11-09" → "Mon 9 Nov" */
export const dayLabel = (date: string) => dayFormat.format(new Date(`${date.slice(0, 10)}T00:00:00Z`));

/**
 * How a planned session compares with the longest run of the last 30 days: the larger of the
 * distance and time ratios, 0 when there's nothing to compare.
 */
export function spikeRatio(
  planned: { distance?: number | null; moving_time?: number | null },
  longestDistance?: number,
  longestTime?: number,
): number {
  return Math.max(
    longestDistance && planned.distance ? planned.distance / longestDistance : 0,
    longestTime && planned.moving_time ? planned.moving_time / longestTime : 0,
  );
}
