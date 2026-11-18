import type { IntervalsActivity, IntervalsEvent } from "./intervals.ts";
import { addDays } from "./intervals.ts";
import { levelInName } from "./ladder.ts";
import { HARD_NAME, SPIKE_FACTOR, dayLabel, dayOf, daysBetween, sportOf, spikeRatio, weekStart, weekdayOf } from "./sessions.ts";

/**
 * The plan check: the calendar's next 14 days against Wout's hard rules (context doc sections
 * 3, 10 and 11), worked out by the Worker. The coach may not propose or write a plan that
 * breaks one. Done sessions of the current week count too (a third run, a second quality ride).
 */

const AHEAD_DAYS = 14;
const MAX_RUNS_PER_WEEK = 2;
const MAX_INDOOR_S = 2 * 3600;
const RUN_DAYS = [1, 2, 3, 4]; // Mon–Thu
const RIDE_DAYS = [5, 6, 0]; // Fri–Sun, other days only in a Home week
const HOME_WEEK = /home ?week/i;

interface Item {
  date: string;
  sport: ReturnType<typeof sportOf>;
  name: string;
  planned: boolean;
  hard: boolean;
  indoor: boolean;
  event?: IntervalsEvent;
}

/** Days covered by a calendar NOTE with "Home week" in its name (end date exclusive). */
export function inHomeWeek(date: string, events: IntervalsEvent[]): boolean {
  return events.some((e) => {
    if (e.category !== "NOTE" || !HOME_WEEK.test(e.name ?? "")) return false;
    const start = e.start_date_local.slice(0, 10);
    const end = e.end_date_local?.slice(0, 10) ?? start;
    return date === start || (date > start && date < end);
  });
}

export interface PlanCheckInput {
  events: IntervalsEvent[]; // must cover this week and the next 14 days (plus Home week notes)
  activities: IntervalsActivity[]; // newest first
  today: string;
  allowedLevel?: number; // from the ladder gate
  longestDistance?: number; // longest run of the last 30 days
  longestTime?: number;
}

/** The rules a plan breaks, one line each, in date order. Empty = all met. */
export function planCheck(input: PlanCheckInput): string[] {
  const { events, activities, today } = input;
  const until = addDays(today, AHEAD_DAYS);
  const from = weekStart(today);
  const planned: Item[] = events
    .filter((e) => e.category === "WORKOUT" && !e.paired_activity_id && dayOf(e) >= today && dayOf(e) <= until)
    .map((e) => ({
      date: dayOf(e),
      sport: sportOf(e),
      name: e.name || e.type || "session",
      planned: true,
      hard: HARD_NAME.test(e.name ?? ""),
      indoor: !!e.indoor || e.type === "VirtualRide",
      event: e,
    }));
  const done: Item[] = activities
    .filter((a) => dayOf(a) >= addDays(from, -1) && dayOf(a) <= today)
    .map((a) => ({
      date: dayOf(a),
      sport: sportOf(a),
      name: a.name || a.type || "session",
      planned: false,
      hard: HARD_NAME.test(a.name ?? ""),
      indoor: !!a.trainer || a.type === "VirtualRide",
    }));
  const all = [...done, ...planned].sort((a, b) => a.date.localeCompare(b.date));
  const problems: string[] = [];
  const at = (item: Item) => `${dayLabel(item.date)} · ${item.name}`;

  const runs = all.filter((i) => i.sport === "run");
  const plannedRuns = planned.filter((i) => i.sport === "run");
  for (const run of plannedRuns) {
    if (!RUN_DAYS.includes(weekdayOf(run.date))) problems.push(`${at(run)}: a run outside Mon–Thu (runs are weekdays only)`);
    const before = runs.filter((r) => r !== run && daysBetween(r.date, run.date) === 1);
    if (before.length) problems.push(`${at(run)}: a run the day after another run (runs never on consecutive days)`);
    const ratio = spikeRatio(run.event!, input.longestDistance, input.longestTime);
    if (ratio > SPIKE_FACTOR) problems.push(`${at(run)}: +${Math.round((ratio - 1) * 100)}% vs the longest run of the last 30 days (over the +10% line)`);
  }
  for (const [i, run] of plannedRuns.entries()) {
    const level = levelInName(run.name);
    // The next run may go up to the gate's level; a later one at most one more (if the next is clean).
    const max = input.allowedLevel === undefined ? undefined : input.allowedLevel + (i === 0 ? 0 : 1);
    if (level && max && level > max) {
      problems.push(`${at(run)}: L${level}, but the ladder gate allows at most L${max}${i === 0 ? "" : " (one level up after a clean next run)"}`);
    }
  }
  for (const [week, items] of groupBy(runs, (r) => weekStart(r.date))) {
    if (items.length > MAX_RUNS_PER_WEEK && items.some((r) => r.planned)) {
      problems.push(`week of ${dayLabel(week)}: ${items.length} runs (max ${MAX_RUNS_PER_WEEK}; a 3rd only after several clean 2-run weeks and when Wout agreed)`);
    }
  }

  const rides = all.filter((i) => i.sport === "ride");
  for (const ride of planned.filter((i) => i.sport === "ride")) {
    if (!RIDE_DAYS.includes(weekdayOf(ride.date)) && !inHomeWeek(ride.date, events)) {
      problems.push(`${at(ride)}: a ride on a school day without a "Home week" note`);
    }
    if (ride.indoor && (ride.event?.moving_time ?? 0) > MAX_INDOOR_S) problems.push(`${at(ride)}: indoor ride over 2 h`);
    if (ride.hard && rides.some((r) => r !== ride && r.hard && daysBetween(r.date, ride.date) === 1)) {
      problems.push(`${at(ride)}: a hard ride the day after another hard ride`);
    }
  }
  for (const [week, items] of groupBy(rides.filter((r) => r.hard), (r) => weekStart(r.date))) {
    if (items.length > 1 && items.some((r) => r.planned)) {
      problems.push(`week of ${dayLabel(week)}: ${items.length} quality rides (max 1 a week)`);
    }
  }

  for (const strength of planned.filter((i) => i.sport === "strength" && /strength a\b/i.test(i.name))) {
    if (runs.some((r) => r.date === strength.date)) problems.push(`${at(strength)}: Strength A on a run day (no heavy calf work on a run day)`);
  }
  return [...new Set(problems)];
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

export function planCheckLines(problems: string[]): string[] {
  return problems.length
    ? [`Plan check (next ${AHEAD_DAYS} days, Worker rules): ${problems.length} problem${problems.length === 1 ? "" : "s"}, fix before planning more:`, ...problems.map((p) => `- ⚠️ ${p}`)]
    : [`Plan check (next ${AHEAD_DAYS} days, Worker rules): ✅ all rules met`];
}
