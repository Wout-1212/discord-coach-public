import { type IntervalsActivity, type IntervalsEvent, addDays } from "./intervals.ts";
import { formatDuration } from "./plan.ts";
import { dayLabel, dayOf, sportOf, weekStart } from "./sessions.ts";

/**
 * Plan vs actual for the last 7 days, worked out by the Worker so the coach starts every
 * activity comment from the plan, not from praise. A planned ride replaced by another ride the
 * same day (an outdoor ride instead of the indoor one) is a swap, never a miss. The week total
 * compares only the days that have passed.
 */

const DAYS = 7;
const SHORT = 0.8; // under 80% of the planned time = shorter

const duration = (seconds?: number | null) => (seconds ? formatDuration(seconds) : "?");

function hrOnly(a: IntervalsActivity): boolean {
  return sportOf(a) === "ride" && !a.trainer && a.type !== "VirtualRide" && !(a.icu_average_watts ?? 0);
}

export function planActualLines(events: IntervalsEvent[], activities: IntervalsActivity[], today: string): string[] {
  const from = addDays(today, -(DAYS - 1));
  const inWindow = (date: string) => date >= from && date <= today;
  const planned = events.filter((e) => e.category === "WORKOUT" && inWindow(dayOf(e)));
  const done = activities.filter((a) => inWindow(dayOf(a)));
  const byId = new Map(done.map((a) => [a.id, a]));
  const claimed = new Set(planned.map((e) => e.paired_activity_id).filter((id): id is string => !!id));

  const rows: { date: string; text: string }[] = [];
  const add = (date: string, text: string) => rows.push({ date, text });
  for (const e of planned) {
    const date = dayOf(e);
    const head = `- ${dayLabel(date)} · ${e.name || e.type || "session"} (planned ${duration(e.moving_time)})`;
    const paired = e.paired_activity_id ? byId.get(e.paired_activity_id) : undefined;
    if (e.paired_activity_id) {
      const ratio = paired?.moving_time && e.moving_time ? paired.moving_time / e.moving_time : undefined;
      const what = ratio !== undefined && ratio < SHORT ? "shorter" : "done";
      add(date, `${head}: ${what}${paired ? `, ${duration(paired.moving_time)}` : ""}${ratio !== undefined ? ` (${Math.round(ratio * 100)}%)` : ""}`);
      continue;
    }
    const swap = done.find((a) => !claimed.has(a.id) && dayOf(a) === date && sportOf(a) === sportOf(e));
    if (swap) {
      claimed.add(swap.id);
      const word = sportOf(e) === "ride" ? "swapped for" : "done as";
      add(date, `${head}: ${word} ${swap.name || swap.type} (${duration(swap.moving_time)}${hrOnly(swap) ? ", load HR-based" : ""}), not a miss`);
    } else {
      add(date, `${head}: ${date === today ? "not done yet" : "missed"}`);
    }
  }
  for (const a of done.filter((a) => !claimed.has(a.id))) {
    add(dayOf(a), `- ${dayLabel(dayOf(a))} · ${a.name || a.type} (${duration(a.moving_time)}): extra, not planned${hrOnly(a) ? " (load HR-based)" : ""}`);
  }
  const lines = rows.sort((a, b) => a.date.localeCompare(b.date)).map((r) => r.text);

  // This week, only the days so far: planned up to yesterday plus today's done sessions.
  const monday = weekStart(today);
  const weekPlanned = planned.filter((e) => dayOf(e) >= monday && (dayOf(e) < today || e.paired_activity_id));
  const weekDone = done.filter((a) => dayOf(a) >= monday);
  const sum = (items: { moving_time?: number | null }[]) => items.reduce((s, i) => s + (i.moving_time ?? 0), 0);
  const total = `Week so far (${dayLabel(monday)}–${dayLabel(today)}): planned ${formatDuration(sum(weekPlanned))}, done ${formatDuration(sum(weekDone))}`;

  return lines.length
    ? [`Plan vs actual, last ${DAYS} days (Worker; start every activity comment from this):`, ...lines, total]
    : [`Plan vs actual, last ${DAYS} days: nothing planned or done.`];
}

