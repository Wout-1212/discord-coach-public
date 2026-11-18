import {
  type IntervalsActivity,
  IntervalsError,
  getActivity,
  listRecentActivities,
  postActivityMessage,
  updateActivity,
} from "./intervals.ts";
import type { Env, InteractionOption } from "./types.ts";

/**
 * `/feedback feel rpe notes activity`: saves how an activity went on the activity itself
 * in Intervals: feel and RPE in their fields, notes as a "Feedback: …" message under the
 * activity. The 🦵 button under a run (nudge.ts) saves a "Pain: …" message the same way.
 * Never in the description: Intervals pushes that to Strava, where it can become public.
 * Older activities may still have these lines in their description; readers accept both.
 */

/** Intervals' feel scale: 1 = Strong … 5 = Weak. */
export const FEEL_LABELS = ["Strong", "Good", "Normal", "Poor", "Weak"] as const;
export const FEEDBACK_PREFIX = "Feedback:";
export const PAIN_PREFIX = "Pain:";
export const NEXT_MORNING_PREFIX = "Next morning";

const LOOKBACK_DAYS = 7;
// Discord drops autocomplete answers after 3 s.
const AUTOCOMPLETE_TIMEOUT_MS = 2_500;

export interface FeedbackInput {
  activityId?: string;
  feel?: number;
  rpe?: number;
  notes?: string;
  pain?: string; // "calf 3/10, during, same"
}

export function readFeedbackOptions(options: InteractionOption[] = []): FeedbackInput {
  const get = (name: string) => options.find((o) => o.name === name)?.value;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    activityId: str(get("activity")),
    feel: num(get("feel")),
    rpe: num(get("rpe")),
    notes: str(get("notes")),
  };
}

const labelFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", // start_date_local is already local time
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "Tue 03 Nov, 11:00 · Ride — Aerobic Foundation 90m" (max 100 chars, Discord's limit). */
export function activityLabel(a: IntervalsActivity): string {
  const when = labelFormat.format(new Date(`${a.start_date_local.slice(0, 19)}Z`));
  const label = `${when} · ${a.name || a.type || "Activity"}`;
  return label.length <= 100 ? label : `${label.slice(0, 99)}…`;
}

/** Choices for the `activity` option, filtered by what has been typed so far. */
export async function activityChoices(
  env: Env,
  typed: string,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string; value: string }[]> {
  try {
    const query = typed.trim().toLowerCase();
    const list = await listRecentActivities(env, now, LOOKBACK_DAYS, fetchImpl, AUTOCOMPLETE_TIMEOUT_MS);
    return list
      .map((a) => ({ name: activityLabel(a), value: a.id }))
      .filter((c) => !query || c.name.toLowerCase().includes(query))
      .slice(0, 25);
  } catch (err) {
    console.error("activity autocomplete failed:", (err as Error).message);
    return [];
  }
}

/** Save the feedback and return the message to show in Discord. Never throws. */
export async function saveFeedback(
  env: Env,
  input: FeedbackInput,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return (await recordFeedback(env, input, now, fetchImpl)).message;
}

/**
 * Save the feedback. `message` is what to show in Discord; `activity` (as it was before the
 * save) is only set when it was saved. Never throws.
 */
export async function recordFeedback(
  env: Env,
  input: FeedbackInput,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ message: string; activity?: IntervalsActivity }> {
  const fail = (message: string) => ({ message });
  try {
    let activity: IntervalsActivity | undefined;
    if (input.activityId) {
      if (!/^i?\d+$/.test(input.activityId)) {
        return fail("⚠️ Pick an activity from the list (start typing in the `activity` option), or leave it empty for the most recent one.");
      }
      activity = await getActivity(env, input.activityId, fetchImpl);
    } else {
      activity = (await listRecentActivities(env, now, LOOKBACK_DAYS, fetchImpl))[0];
      if (!activity) return fail(`⚠️ No activities in the last ${LOOKBACK_DAYS} days to add feedback to.`);
    }

    const fields: Parameters<typeof updateActivity>[2] = {};
    if (input.feel) fields.feel = input.feel;
    if (input.rpe) fields.icu_rpe = input.rpe;
    if (Object.keys(fields).length) await updateActivity(env, activity.id, fields, fetchImpl);
    // Words go in messages, never in the description (Strava gets the description).
    if (input.notes) await postActivityMessage(env, activity.id, `${FEEDBACK_PREFIX} ${input.notes}`, fetchImpl);
    if (input.pain) await postActivityMessage(env, activity.id, `${PAIN_PREFIX} ${input.pain}`, fetchImpl);

    const parts = [
      input.feel ? `Feel: ${FEEL_LABELS[input.feel - 1] ?? input.feel} (${input.feel}/5)` : "",
      input.rpe ? `RPE: ${input.rpe}/10` : "",
    ].filter(Boolean);
    const lines = [`📝 Feedback saved on **${activityLabel(activity)}**`];
    if (parts.length) lines.push(parts.join(" · "));
    if (input.notes) lines.push(...input.notes.split("\n").map((l) => `> ${l}`));
    if (input.pain) lines.push(`🦵 Pain: ${input.pain}`);
    return { message: lines.join("\n"), activity };
  } catch (err) {
    console.error("feedback failed:", (err as Error).message);
    if (err instanceof IntervalsError && (err.status === 401 || err.status === 403)) {
      return fail("⚠️ Intervals rejected the API key. Set it with `npx wrangler secret put INTERVALS_API_KEY`.");
    }
    if (err instanceof IntervalsError && err.status === 404) {
      return fail("⚠️ Intervals doesn't know that activity. Pick one from the list.");
    }
    return fail(`⚠️ Couldn't save the feedback (${(err as Error).message}). Try again in a minute.`);
  }
}
