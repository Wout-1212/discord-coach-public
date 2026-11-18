import { FEEL_LABELS } from "./feedback.ts";
import {
  type ActivityInterval,
  type IntervalsActivity,
  type IntervalsEvent,
  type IntervalsWellness,
  type WorkoutStep,
  addDays,
  brusselsDate,
  getActivityIntervals,
  listEvents,
  listRecentActivities,
  listWellness,
} from "./intervals.ts";
import { hrCap, ladderGate, ladderLines } from "./ladder.ts";
import { type Note, descriptionNotes, recentNotes } from "./notes.ts";
import { planActualLines } from "./plan-actual.ts";
import { planCheck, planCheckLines } from "./plan-check.ts";
import {
  HARD_NAME,
  RUN_WINDOW_DAYS,
  SPIKE_FACTOR,
  STEADY_NAME,
  type Sport,
  clock,
  dayOf,
  shortDate,
  sportOf,
  spikeRatio,
} from "./sessions.ts";
import type { Env } from "./types.ts";

/**
 * The "training history" block in every coach run: the same facts each time, worked out by
 * the Worker, so the coach doesn't re-derive them from raw activity lists. Intervals stays the
 * source of truth: this only reads its numbers and sorts them. No scores, and missing data
 * stays missing. On top: data freshness, the morning check, and the Worker's two decisions
 * (ladder gate, plan check), then plan vs actual. Costs one activity list, one wellness and one
 * calendar read, one segments read per recent run and one messages read per activity of the
 * last 14 days.
 */

/** Intervals' self-rated fatigue scale, 1 = low … 4 = extreme, as the morning check shows it. */
export const FATIGUE_LABELS = ["Very fresh", "Fresh", "Tired", "Very tired"] as const;
const NOTE_CHARS = 200;
const NOTES_SHOWN = 8;

const HISTORY_DAYS = 90;
const DETAILED_RUNS = 3;
const PAST_PLAN_DAYS = 7; // plan vs actual, and this week's runs for the plan check
const PLAN_AHEAD_DAYS = 14;
const PLANNED_RUNS_SHOWN = 2;
const RIDES_SHOWN = 8;
const PAIN_DAYS = 14;
const BASELINE_DAYS = 28;
const MIN_BASELINE_VALUES = 14; // fewer days don't make a usual range
const MIN_RIDE_S = 50 * 60;
const MAX_RIDE_S = 130 * 60;
const MIN_FLAG_S = 10 * 60;
const HISTORY_BUDGET_MS = 8_000;

// Run/walk is told apart by cadence: Intervals calls every segment WORK. Wout runs at about 80
// and walks at about 55; anything in between is too close to call.
const MIN_RUN_CADENCE = 70;
const MAX_WALK_CADENCE = 62;
const MIN_SEGMENT_S = 15; // the odd seconds left over when the watch stops
const SAME_LENGTH_S = 3;

const HISTORY_FIELDS = [
  "id",
  "name",
  "type",
  "start_date_local",
  "description",
  "distance",
  "moving_time",
  "trainer",
  "average_heartrate",
  "icu_average_watts",
  "decoupling",
  "icu_efficiency_factor",
  "feel",
  "icu_rpe",
];

const isRun = (a: IntervalsActivity) => !!a.type?.includes("Run");
const hasHeartRate = (a: IntervalsActivity) => (a.average_heartrate ?? 0) > 0;

const km = (metres: number) => `${(metres / 1000).toFixed(2)} km`;

export interface RunSegments {
  count: number;
  totalSeconds: number;
  longestSeconds: number;
  sameLength: boolean;
  heartRate?: number; // time-weighted over the run segments
}

/** The running part of a session, or undefined when run and walk can't be told apart. */
export function runSegments(intervals: ActivityInterval[]): RunSegments | undefined {
  const segments = intervals.filter((i) => (i.moving_time ?? 0) >= MIN_SEGMENT_S);
  const running: ActivityInterval[] = [];
  for (const segment of segments) {
    const cadence = segment.average_cadence;
    if (typeof cadence !== "number") return undefined;
    if (cadence >= MIN_RUN_CADENCE) running.push(segment);
    else if (cadence > MAX_WALK_CADENCE) return undefined;
  }
  if (!running.length) return undefined;

  const seconds = running.map((s) => s.moving_time!);
  const totalSeconds = seconds.reduce((sum, s) => sum + s, 0);
  const withHeartRate = running.filter((s) => (s.average_heartrate ?? 0) > 0);
  const weight = withHeartRate.reduce((sum, s) => sum + s.moving_time!, 0);
  return {
    count: running.length,
    totalSeconds,
    longestSeconds: Math.max(...seconds),
    sameLength: Math.max(...seconds) - Math.min(...seconds) <= SAME_LENGTH_S,
    heartRate: weight
      ? Math.round(withHeartRate.reduce((sum, s) => sum + s.average_heartrate! * s.moving_time!, 0) / weight)
      : undefined,
  };
}

/** "10×45 s", "continuous" or "4 run segments, longest 2:10". */
function structure(s: RunSegments): string {
  if (s.count === 1) return "continuous";
  if (!s.sameLength) return `${s.count} run segments, longest ${clock(s.longestSeconds)}`;
  const each = Math.round(s.totalSeconds / s.count);
  return `${s.count}×${each < 60 ? `${each} s` : clock(each)}`;
}

/** Planned running time from a workout's steps; undefined when no step is called a run. */
export function plannedRunSeconds(steps: WorkoutStep[] | null | undefined): number | undefined {
  let found = false;
  const total = (list: WorkoutStep[]): number =>
    list.reduce((sum, step) => {
      if (step.steps?.length) return sum + (step.reps ?? 1) * total(step.steps);
      if (!/\brun\b/i.test(step.text ?? "")) return sum;
      found = true;
      return sum + (step.duration ?? 0);
    }, 0);
  const seconds = total(steps ?? []);
  return found ? seconds : undefined;
}

/** The item with the highest positive value, if any. */
export function longest<T>(items: T[], value: (item: T) => number | null | undefined): T | undefined {
  return items.reduce<T | undefined>((best, item) => {
    const size = value(item) ?? 0;
    return size > 0 && size > (best ? (value(best) ?? 0) : 0) ? item : best;
  }, undefined);
}

function feedbackText(a: IntervalsActivity): string {
  const parts = [
    a.feel ? `feel ${FEEL_LABELS[a.feel - 1] ?? a.feel}` : "",
    a.icu_rpe ? `RPE ${a.icu_rpe}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no feedback";
}

function recentRunLine(a: IntervalsActivity, s: RunSegments | undefined): string {
  const running = s
    ? [structure(s), `${clock(s.totalSeconds)} running`, s.heartRate ? `run HR ${s.heartRate}` : ""].filter(Boolean).join(", ")
    : "run and walk segments unclear";
  const session = [a.distance ? km(a.distance) : "", a.moving_time ? clock(a.moving_time) : ""].filter(Boolean).join(", ");
  return `- ${shortDate(dayOf(a))}: ${[running, session, feedbackText(a)].filter(Boolean).join(" · ")}`;
}

/** Where a planned run stands against the longest run of the last 30 days. */
function spikeText(e: IntervalsEvent, longestDistance?: number, longestTime?: number): string {
  if (!longestDistance && !longestTime) return "no runs to compare with";
  const ratio = spikeRatio(e, longestDistance, longestTime);
  if (!ratio) return "can't compare: no duration planned";
  return ratio > SPIKE_FACTOR
    ? `⚠️ over the line (+${Math.round((ratio - 1) * 100)}% vs the longest)`
    : "under the line";
}

function plannedRunLine(e: IntervalsEvent, longestDistance?: number, longestTime?: number): string {
  const running = plannedRunSeconds(e.workout_doc?.steps);
  const session = [
    e.moving_time ? clock(e.moving_time) : "",
    running ? `(${clock(running)} running)` : "",
  ].filter(Boolean).join(" ");
  return `Next planned: ${[shortDate(e.start_date_local), session].filter(Boolean).join(" ")} · ${spikeText(e, longestDistance, longestTime)}`;
}

export function runLines(
  activities: IntervalsActivity[],
  segments: Map<string, RunSegments | undefined>,
  events: IntervalsEvent[] | undefined,
  today: string,
): string[] {
  const runs = activities.filter(isRun);
  const since = addDays(today, -RUN_WINDOW_DAYS);
  const recent = runs.filter((r) => dayOf(r) >= since);
  const farthest = longest(recent, (r) => r.distance);
  const longestSession = longest(recent, (r) => r.moving_time);

  const lines: string[] = [];
  if (!recent.length) {
    lines.push(`Runs, last ${RUN_WINDOW_DAYS} days: none, so there's no longest session to compare with.`);
  } else {
    const days = Math.round((Date.parse(today) - Date.parse(dayOf(recent[0]!))) / 86_400_000);
    const parts = [`${recent.length} session${recent.length === 1 ? "" : "s"}`];
    if (farthest) parts.push(`longest ${km(farthest.distance!)} (${shortDate(dayOf(farthest))})`);
    if (longestSession) parts.push(`longest ${clock(longestSession.moving_time!)} (${shortDate(dayOf(longestSession))})`);
    const line = [
      farthest ? km(farthest.distance! * SPIKE_FACTOR) : "",
      longestSession ? clock(longestSession.moving_time! * SPIKE_FACTOR) : "",
    ].filter(Boolean);
    if (line.length) parts.push(`+10% line ${line.join(" / ")}`);
    parts.push(days === 0 ? "last run today" : `last run ${days} day${days === 1 ? "" : "s"} ago`);
    lines.push(`Runs, last ${RUN_WINDOW_DAYS} days: ${parts.join(" · ")}`);
  }

  const latest = runs.slice(0, DETAILED_RUNS);
  if (latest.length) {
    lines.push(`Last ${latest.length === 1 ? "run" : `${latest.length} runs`}:`);
    lines.push(...latest.map((r) => recentRunLine(r, segments.get(r.id))));
  }

  if (!events) {
    lines.push("Next planned: calendar unavailable");
  } else {
    const planned = events.filter(
      (e) => e.category === "WORKOUT" && e.type?.includes("Run") && !e.paired_activity_id,
    );
    lines.push(
      ...planned
        .slice(0, PLANNED_RUNS_SHOWN)
        .map((e) => plannedRunLine(e, farthest?.distance ?? undefined, longestSession?.moving_time ?? undefined)),
    );
  }
  return lines;
}

/** A steady indoor ride with power and HR: the only rides whose numbers compare with each other. */
export function isComparableRide(a: IntervalsActivity): boolean {
  const seconds = a.moving_time ?? 0;
  return (
    a.type === "VirtualRide" &&
    (a.icu_average_watts ?? 0) > 0 &&
    hasHeartRate(a) &&
    typeof a.decoupling === "number" &&
    seconds >= MIN_RIDE_S &&
    seconds <= MAX_RIDE_S &&
    STEADY_NAME.test(a.name ?? "") &&
    !HARD_NAME.test(a.name ?? "")
  );
}

function rideLine(a: IntervalsActivity): string {
  const parts = [
    clock(a.moving_time!),
    `${Math.round(a.icu_average_watts!)} W`,
    `HR ${Math.round(a.average_heartrate!)}`,
    a.icu_efficiency_factor ? `EF ${a.icu_efficiency_factor.toFixed(2)}` : "",
    `decoupling ${a.decoupling!.toFixed(1)}%`,
    feedbackText(a),
  ].filter(Boolean);
  return `- ${shortDate(dayOf(a))}: ${parts.join(" · ")}`;
}

export function rideLines(activities: IntervalsActivity[]): string[] {
  const comparable = activities.filter(isComparableRide);
  const shown = comparable.slice(0, RIDES_SHOWN);
  const lines = comparable.length
    ? [
        `Steady indoor Z2 rides, last ${HISTORY_DAYS} days: ${comparable.length} comparable${comparable.length > shown.length ? `, latest ${shown.length}` : ""}:`,
        ...shown.map(rideLine),
      ]
    : [`Steady indoor Z2 rides, last ${HISTORY_DAYS} days: none comparable.`];

  const outdoor = activities.filter((a) => a.type === "Ride" && !a.trainer);
  const latest = outdoor[0];
  if (latest) {
    const heartRate = hasHeartRate(latest) ? `, avg HR ${Math.round(latest.average_heartrate!)}` : "";
    lines.push(
      `Outdoor rides: ${outdoor.length} in ${HISTORY_DAYS} days, latest ${shortDate(dayOf(latest))}${heartRate}. Not comparable with indoor rides.`,
    );
  }
  return lines;
}

/** A day's value against the days before it. A range to read, not a verdict on one reading. */
function trendLine(
  label: string,
  field: "hrv" | "restingHR",
  days: IntervalsWellness[],
  oldest: string,
): string {
  const recorded = days.filter((d) => (d[field] ?? 0) > 0);
  const latest = recorded.at(-1);
  if (!latest) return `${label}: no data`;
  const value = Math.round(latest[field]!);
  const earlier = recorded.slice(0, -1).map((d) => d[field]!);
  const span = Math.round((Date.parse(latest.id) - Date.parse(oldest)) / 86_400_000);
  const head = `${label} ${value} on ${shortDate(latest.id)}`;
  if (earlier.length < MIN_BASELINE_VALUES) {
    return `${head} · only ${earlier.length} of ${span} earlier days recorded, too few for a usual range`;
  }
  const mean = earlier.reduce((sum, v) => sum + v, 0) / earlier.length;
  const spread = Math.sqrt(earlier.reduce((sum, v) => sum + (v - mean) ** 2, 0) / earlier.length);
  const [low, high] = [Math.round(mean - spread), Math.round(mean + spread)];
  const outside = value < low || value > high ? " · outside it" : "";
  return `${head} · usual ${low}–${high}${outside} · ${earlier.length} of ${span} earlier days recorded`;
}

export function wellnessLines(days: IntervalsWellness[] | undefined, oldest: string): string[] {
  if (!days) return ["Wellness: unavailable"];
  return [trendLine("HRV", "hrv", days, oldest), trendLine("Resting HR", "restingHR", days, oldest)];
}

/** Sessions that can't be compared because a sensor failed. Strength never has this data. */
export function flagLines(activities: IntervalsActivity[], today: string): string[] {
  const since = addDays(today, -RUN_WINDOW_DAYS);
  const flagged = activities.filter(
    (a) =>
      (isRun(a) || a.type?.includes("Ride")) &&
      dayOf(a) >= since &&
      (a.moving_time ?? 0) >= MIN_FLAG_S &&
      !hasHeartRate(a),
  );
  return flagged.length
    ? ["Data flags:", ...flagged.map((a) => `- ${shortDate(dayOf(a))} ${isRun(a) ? "run" : "ride"}: no heart rate, left out of comparisons`)]
    : [];
}

/** Pain reports on recent activities (the 🦵 button, nudge.ts): messages, or older description lines. */
export function painLines(activities: IntervalsActivity[], notes: Map<string, Note[]>, today: string): string[] {
  const since = addDays(today, -PAIN_DAYS);
  const reports = activities
    .filter((a) => dayOf(a) >= since)
    .flatMap((a) =>
      (notes.get(a.id) ?? descriptionNotes(a.description))
        .filter((n) => n.kind === "pain")
        .map((n) => `- ${shortDate(dayOf(a))}: ${n.text}`),
    );
  return reports.length
    ? [`Pain reports, last ${PAIN_DAYS} days:`, ...reports]
    : [`Pain reports, last ${PAIN_DAYS} days: none logged (that means unknown, not pain-free).`];
}

/**
 * Wout's own words on recent activities: Feedback: notes, next-morning checks and anything else
 * written under an activity in Intervals. Montis doesn't show activity messages, so they're here.
 */
export function noteLines(activities: IntervalsActivity[], notes: Map<string, Note[]>): string[] {
  const lines = activities
    .flatMap((a) =>
      (notes.get(a.id) ?? [])
        .filter((n) => n.kind !== "pain")
        .map((n) => {
          const label = n.kind === "next-morning" ? "next morning: " : "";
          const text = n.text.replace(/\s+/g, " ");
          return `- ${shortDate(dayOf(a))} ${a.name || a.type}: ${label}${text.length > NOTE_CHARS ? `${text.slice(0, NOTE_CHARS)}…` : text}`;
        }),
    )
    .slice(0, NOTES_SHOWN);
  return lines.length
    ? [`Feedback notes, last ${PAIN_DAYS} days (activity messages, newest activity first):`, ...lines]
    : [`Feedback notes, last ${PAIN_DAYS} days: none.`];
}

const asOfFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Brussels",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * When each kind of data was last recorded, so a sync gap shows as missing data instead of a
 * confident call on old numbers (the Intervals/Garmin API change may cut Garmin data off).
 */
export function freshnessLines(
  activities: IntervalsActivity[],
  wellness: IntervalsWellness[] | undefined,
  today: string,
  now: Date,
): string[] {
  const last = (sport: Sport) => activities.find((a) => sportOf(a) === sport);
  const run = last("run");
  const ride = last("ride");
  const recorded = wellness?.filter((d) => (d.hrv ?? 0) > 0 || (d.restingHR ?? 0) > 0).at(-1);
  const wellnessText = !wellness
    ? "wellness unavailable"
    : recorded
      ? `wellness (HRV/RHR) last recorded ${shortDate(recorded.id)}`
      : `no HRV/RHR recorded in ${BASELINE_DAYS} days`;
  const parts = [
    wellnessText,
    `last run ${run ? shortDate(dayOf(run)) : `none in ${HISTORY_DAYS} days`}`,
    `last ride ${ride ? shortDate(dayOf(ride)) : `none in ${HISTORY_DAYS} days`}`,
  ];
  const lines = [`Data as of ${asOfFormat.format(now)} (Brussels): ${parts.join(" · ")}`];
  if (wellness && (!recorded || recorded.id < addDays(today, -1))) {
    lines.push(
      `⚠️ No HRV/RHR since ${recorded ? shortDate(recorded.id) : `${BASELINE_DAYS}+ days`}: say the data is missing, use feel and the morning check instead, never guess values.`,
    );
  }
  return lines;
}

/** Today's morning check (checkin.ts): fatigue in wellness, legs as a message on the last run. */
export function morningCheckLine(
  wellness: IntervalsWellness[] | undefined,
  activities: IntervalsActivity[],
  notes: Map<string, Note[]>,
  today: string,
): string {
  const fatigue = wellness?.find((d) => d.id === today)?.fatigue;
  const run = activities.find((a) => sportOf(a) === "run");
  const legs = run
    ? (notes.get(run.id) ?? []).filter((n) => n.kind === "next-morning" && brusselsDate.format(new Date(n.created ?? 0)) === today).at(-1)
    : undefined;
  const parts = [
    fatigue ? `feels ${FATIGUE_LABELS[fatigue - 1] ?? fatigue} (fatigue ${fatigue}/4)` : "",
    legs && run ? `legs after the ${shortDate(dayOf(run))} run: ${legs.text}` : "",
  ].filter(Boolean);
  return `Morning check (today): ${parts.length ? parts.join(" · ") : "not answered yet"}`;
}

/**
 * The block for the coach's run input. Never throws: a coach run shouldn't depend on it.
 * Gives up after `budgetMs`: the run is started from a `waitUntil` (30 s in all), and the
 * fire itself can take 15 s of that.
 */
export async function historySection(
  env: Env,
  now: Date,
  fetchImpl: typeof fetch = fetch,
  budgetMs = HISTORY_BUDGET_MS,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      console.error(`training history: no answer within ${budgetMs} ms`);
      resolve(`(training history unavailable: Intervals didn't answer within ${Math.round(budgetMs / 1000)} s)`);
    }, budgetMs);
  });
  try {
    return await Promise.race([buildHistory(env, now, fetchImpl), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface TrainingData {
  today: string;
  activities: IntervalsActivity[]; // last 90 days, newest first
  events?: IntervalsEvent[]; // the last 7 days and the next 14 (undefined when the calendar failed)
  wellness?: IntervalsWellness[]; // last 28 days
  segments: Map<string, RunSegments | undefined>; // the last 3 runs
  notes: Map<string, Note[]>; // activities of the last 14 days
}

/** Everything the block and the gates need. Throws only when the activity list fails. */
export async function loadTrainingData(env: Env, now: Date, fetchImpl: typeof fetch = fetch): Promise<TrainingData> {
  const today = brusselsDate.format(now);
  const quietly = <T>(what: string, work: Promise<T>): Promise<T | undefined> =>
    work.catch((err) => {
      console.error(`history: ${what} failed:`, (err as Error).message);
      return undefined;
    });
  const wellness = quietly("wellness", listWellness(env, addDays(today, -BASELINE_DAYS), today, fetchImpl));
  const events = quietly(
    "calendar",
    listEvents(env, addDays(today, -PAST_PLAN_DAYS), addDays(today, PLAN_AHEAD_DAYS), fetchImpl),
  );

  const activities = await listRecentActivities(env, now, HISTORY_DAYS, fetchImpl, undefined, HISTORY_FIELDS);
  const latestRuns = activities.filter(isRun).slice(0, DETAILED_RUNS);
  const [details, notes] = await Promise.all([
    Promise.all(latestRuns.map((r) => quietly(`segments of ${r.id}`, getActivityIntervals(env, r.id, fetchImpl)))),
    recentNotes(env, activities, today, PAIN_DAYS, fetchImpl),
  ]);
  const segments = new Map(latestRuns.map((r, i) => [r.id, details[i] ? runSegments(details[i]) : undefined]));
  return { today, activities, events: await events, wellness: await wellness, segments, notes };
}

/** The Worker's decisions: the ladder gate and the plan check (undefined without a calendar). */
export function trainingGates(data: TrainingData, env: Pick<Env, "RUN_HR_CAP">) {
  const { activities, notes, segments, today } = data;
  const recent = activities.filter((a) => isRun(a) && dayOf(a) >= addDays(today, -RUN_WINDOW_DAYS));
  const longestDistance = longest(recent, (r) => r.distance)?.distance ?? undefined;
  const longestTime = longest(recent, (r) => r.moving_time)?.moving_time ?? undefined;
  const runs = activities
    .filter(isRun)
    .slice(0, DETAILED_RUNS)
    .map((run) => ({ run, segments: segments.get(run.id), notes: notes.get(run.id) ?? descriptionNotes(run.description) }));
  const ladder = ladderGate(runs, activities, notes, today, hrCap(env), longestTime);
  const problems = data.events
    ? planCheck({ events: data.events, activities, today, allowedLevel: ladder.allowed, longestDistance, longestTime })
    : undefined;
  return { ladder, problems };
}

async function buildHistory(env: Env, now: Date, fetchImpl: typeof fetch): Promise<string> {
  try {
    const data = await loadTrainingData(env, now, fetchImpl);
    const { today, activities, events, wellness, segments, notes } = data;
    const { ladder, problems } = trainingGates(data, env);
    const upcoming = events?.filter((e) => dayOf(e) >= today);

    return [
      ...freshnessLines(activities, wellness, today, now),
      morningCheckLine(wellness, activities, notes, today),
      ...ladderLines(ladder),
      ...(problems ? planCheckLines(problems) : ["Plan check: calendar unavailable, check the rules by hand"]),
      ...(events ? planActualLines(events, activities, today) : ["Plan vs actual: calendar unavailable"]),
      ...runLines(activities, segments, upcoming, today),
      ...painLines(activities, notes, today),
      ...noteLines(activities, notes),
      ...rideLines(activities),
      ...wellnessLines(wellness, addDays(today, -BASELINE_DAYS)),
      ...flagLines(activities, today),
    ].join("\n");
  } catch (err) {
    console.error("training history failed:", (err as Error).message);
    return `(training history unavailable: ${(err as Error).message})`;
  }
}
