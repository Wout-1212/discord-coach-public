import type { Env } from "./types.ts";

/**
 * Minimal Intervals.icu API client (https://intervals.icu/api-docs.html).
 * Auth: HTTP Basic with username "API_KEY" and the athlete's API key as password.
 * Used for /feedback (the Montis connector can't write to completed activities), /plan and
 * the new-activity nudges, so those answer instantly without a Claude run.
 */

const INTERVALS_API = "https://intervals.icu/api/v1";

export interface IntervalsActivity {
  id: string;
  name?: string | null;
  type?: string | null;
  start_date_local: string; // athlete's local time, no zone: 2026-11-03T11:00:22
  description?: string | null;
  feel?: number | null; // 1 = Strong … 5 = Weak
  icu_rpe?: number | null; // 1–10
  moving_time?: number | null; // seconds
  icu_training_load?: number | null;
  distance?: number | null; // metres
  trainer?: boolean | null;
  average_heartrate?: number | null; // 0 when no HR was recorded
  icu_average_watts?: number | null;
  decoupling?: number | null; // %; Intervals only sets it when power and HR both exist
  icu_efficiency_factor?: number | null;
}

/** One detected segment of an activity. Intervals labels run and walk segments alike as WORK. */
export interface ActivityInterval {
  moving_time?: number | null; // seconds
  average_heartrate?: number | null;
  average_cadence?: number | null; // per leg: about 80 running, 55 walking
}

/** One step of a planned workout; a repeat has `reps` and nested `steps`. */
export interface WorkoutStep {
  text?: string | null;
  duration?: number | null; // seconds
  reps?: number | null;
  steps?: WorkoutStep[] | null;
}

/** A planned calendar entry (workout, note, race…). */
export interface IntervalsEvent {
  id: number;
  start_date_local: string; // 2026-11-04T00:00:00
  end_date_local?: string | null; // exclusive: a one-day note ends 2026-11-05T00:00:00
  category: string; // WORKOUT, NOTE, RACE_A/B/C, HOLIDAY, SICK, …
  type?: string | null; // Ride, VirtualRide, Run, WeightTraining, …
  name?: string | null;
  moving_time?: number | null; // seconds
  icu_training_load?: number | null;
  indoor?: boolean | null;
  paired_activity_id?: string | null; // set once a completed activity matches it
  distance?: number | null; // metres; 0 on time-based workouts, so nearly always for runs
  workout_doc?: { steps?: WorkoutStep[] | null } | null;
}

/** One day of wellness data. Garmin's fields stay empty until it has synced. */
export interface IntervalsWellness {
  id: string; // the date, 2026-11-04
  ctl?: number | null;
  atl?: number | null;
  hrv?: number | null; // rMSSD
  restingHR?: number | null;
  sleepSecs?: number | null;
  sleepScore?: number | null;
  fatigue?: number | null; // self-rated, 1 = low … 4 = extreme (the morning check, checkin.ts)
  soreness?: number | null; // self-rated, same scale
}

/** One message under an activity (Intervals' activity chat). Private notes live here, not in the description. */
export interface ActivityMessage {
  id?: number;
  created?: string | null; // ISO time
  content?: string | null;
  deleted?: boolean | null;
}

export class IntervalsError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(`Intervals HTTP ${status}: ${detail}`);
    this.status = status;
  }
}

async function intervals(
  env: Env,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs = 8_000,
): Promise<Response> {
  if (!env.INTERVALS_API_KEY) throw new IntervalsError(401, "INTERVALS_API_KEY is not set");
  const res = await fetchImpl(`${INTERVALS_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${btoa(`API_KEY:${env.INTERVALS_API_KEY}`)}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new IntervalsError(res.status, (await res.text()).slice(0, 200));
  return res;
}

/** Formats a moment as the athlete's local date, YYYY-MM-DD. */
export const brusselsDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" });

/** A local date (YYYY-MM-DD) `days` later; negative for earlier. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Activities from the last `days` days, newest first. `fields` limits what Intervals returns. */
export async function listRecentActivities(
  env: Env,
  now: Date,
  days: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
  fields?: string[],
): Promise<IntervalsActivity[]> {
  const oldest = brusselsDate.format(new Date(now.getTime() - days * 86_400_000));
  const newest = brusselsDate.format(new Date(now.getTime() + 86_400_000));
  const athlete = encodeURIComponent(env.INTERVALS_ATHLETE_ID);
  const res = await intervals(
    env,
    `/athlete/${athlete}/activities?oldest=${oldest}&newest=${newest}${fields ? `&fields=${fields.join(",")}` : ""}`,
    {},
    fetchImpl,
    timeoutMs,
  );
  const list = (await res.json()) as IntervalsActivity[];
  return list
    .filter((a) => a.id && a.start_date_local)
    .sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
}

/** Calendar events between two local dates (YYYY-MM-DD, both inclusive), in date order. */
export async function listEvents(
  env: Env,
  oldest: string,
  newest: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IntervalsEvent[]> {
  const athlete = encodeURIComponent(env.INTERVALS_ATHLETE_ID);
  const res = await intervals(env, `/athlete/${athlete}/events?oldest=${oldest}&newest=${newest}`, {}, fetchImpl);
  const list = (await res.json()) as IntervalsEvent[];
  return list
    .filter((e) => e.start_date_local)
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));
}

/** Daily wellness records between two local dates (both inclusive), oldest first. */
export async function listWellness(
  env: Env,
  oldest: string,
  newest: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IntervalsWellness[]> {
  const athlete = encodeURIComponent(env.INTERVALS_ATHLETE_ID);
  const res = await intervals(env, `/athlete/${athlete}/wellness?oldest=${oldest}&newest=${newest}`, {}, fetchImpl);
  const list = (await res.json()) as IntervalsWellness[];
  return list.filter((w) => w.id).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getActivity(
  env: Env,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IntervalsActivity> {
  const res = await intervals(env, `/activity/${encodeURIComponent(id)}`, {}, fetchImpl);
  return (await res.json()) as IntervalsActivity;
}

/** The detected segments of an activity. */
export async function getActivityIntervals(
  env: Env,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ActivityInterval[]> {
  const res = await intervals(env, `/activity/${encodeURIComponent(id)}/intervals`, {}, fetchImpl);
  return ((await res.json()) as { icu_intervals?: ActivityInterval[] | null }).icu_intervals ?? [];
}

/** The messages under an activity, oldest first, without deleted ones. */
export async function listActivityMessages(
  env: Env,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ActivityMessage[]> {
  const res = await intervals(env, `/activity/${encodeURIComponent(id)}/messages`, {}, fetchImpl);
  const list = ((await res.json()) as ActivityMessage[] | null) ?? [];
  return list.filter((m) => !m.deleted && m.content).sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
}

/**
 * Add a message under an activity. Used instead of the description, which Intervals pushes to
 * Strava (where it can become public) and Garmin Connect can overwrite.
 */
export async function postActivityMessage(
  env: Env,
  id: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await intervals(
    env,
    `/activity/${encodeURIComponent(id)}/messages`,
    { method: "POST", body: JSON.stringify({ content }) },
    fetchImpl,
  );
}

/** Set fields on one day's wellness record (YYYY-MM-DD). */
export async function updateWellness(
  env: Env,
  date: string,
  fields: Partial<Pick<IntervalsWellness, "fatigue" | "soreness">>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const athlete = encodeURIComponent(env.INTERVALS_ATHLETE_ID);
  await intervals(
    env,
    `/athlete/${athlete}/wellness/${date}`,
    { method: "PUT", body: JSON.stringify({ id: date, ...fields }) },
    fetchImpl,
  );
}

export async function updateActivity(
  env: Env,
  id: string,
  fields: Partial<Pick<IntervalsActivity, "feel" | "icu_rpe">>, // never the description: it goes to Strava
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await intervals(
    env,
    `/activity/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(fields) },
    fetchImpl,
  );
}
