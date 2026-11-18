import { dispatchAutomated, postFireFailure } from "./automated.ts";
import type { FireResult } from "./claude.ts";
import { editOriginal } from "./discord.ts";
import { FEEL_LABELS, type FeedbackInput, activityLabel, recordFeedback } from "./feedback.ts";
import { type IntervalsActivity, addDays, brusselsDate } from "./intervals.ts";
import { type Env, OWNER_NAME } from "./types.ts";
import { rideWeatherSection } from "./weather.ts";

/**
 * Automatic analysis after feedback. Sending the 📝 pop-up under an activity nudge (or
 * `/feedback` for an activity from today or yesterday) starts the coach on that activity
 * right away. Each activity is analysed once (KV). A 🦵 pain report sent after the analysis
 * starts one short follow-up; before it, a pain report only waits for the analysis.
 * The 20:35 activity check (scheduled.ts) covers the activities that got no analysis.
 */

export type AnalysisKind = "activity analysis" | "pain follow-up";
export type AnalysisStart = "started" | "skipped" | "failed";

const ANALYSED_PREFIX = "analysed:";
const PAIN_FOLLOWUP_PREFIX = "pain-followup:";
const FLAG_TTL_S = 4 * 86_400; // as long as the nudges remember an activity

const SECTION: Record<AnalysisKind, string> = { "activity analysis": "Activity analysis", "pain follow-up": "Pain follow-up" };
const STARTED_LINE: Record<AnalysisKind, string> = {
  "activity analysis": "🧠 _Coach is analysing it (about a minute)._",
  "pain follow-up": "🧠 _Coach is looking at the pain report (about a minute)._",
};
export const FAILED_LINE = "⚠️ _The coach couldn't start (see the System post). The 20:35 activity check picks it up._";

/** The line to show under the feedback, or undefined when nothing was started. */
export function analysisLine(kind: AnalysisKind, start: AnalysisStart): string | undefined {
  if (start === "started") return STARTED_LINE[kind];
  if (start === "failed") return kind === "activity analysis" ? FAILED_LINE : "⚠️ _The coach couldn't start (see the System post)._";
  return undefined;
}

export async function isAnalysed(env: Env, activityId: string): Promise<boolean> {
  return !!(await env.STATE?.get(`${ANALYSED_PREFIX}${activityId}`));
}

export async function markAnalysed(env: Env, activityId: string): Promise<void> {
  await env.STATE?.put(`${ANALYSED_PREFIX}${activityId}`, "1", { expirationTtl: FLAG_TTL_S });
}

/** Today or yesterday (Brussels): feedback right after an activity, not on an old one. */
export function isRecent(activity: IntervalsActivity, now: Date): boolean {
  return activity.start_date_local.slice(0, 10) >= addDays(brusselsDate.format(now), -1);
}

export function analysisRequest(activity: IntervalsActivity, input: Omit<FeedbackInput, "activityId">, kind: AnalysisKind): string {
  const given = [
    input.feel ? `feel ${FEEL_LABELS[input.feel - 1] ?? input.feel} (${input.feel}/5)` : "",
    input.rpe ? `RPE ${input.rpe}/10` : "",
    input.notes ? `note "${input.notes.replace(/\s+/g, " ")}"` : "",
    input.pain ? `pain "${input.pain}"` : "",
  ].filter(Boolean);
  return [
    kind === "pain follow-up"
      ? `${OWNER_NAME} just reported pain on an activity you already analysed.`
      : `${OWNER_NAME} just gave feedback on this activity.`,
    `Activity: ${activityLabel(activity)} (Intervals id ${activity.id})`,
    `Just given: ${given.join(", ") || "nothing new"}. Read the activity with get_activity for all its feedback, earlier taps included.`,
    `Do the ${kind}: read \`cloud/routines/activity-analysis.md\` in the repository and follow its "${SECTION[kind]}" section.`,
  ].join("\n");
}

/**
 * Start the coach on `activity`, once per activity and kind. The flag is set before the run
 * starts, so two quick pop-ups don't start two runs; a run that can't start clears it again.
 */
export async function startAnalysis(
  env: Env,
  activity: IntervalsActivity,
  input: Omit<FeedbackInput, "activityId">,
  kind: AnalysisKind,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<AnalysisStart> {
  if (!env.STATE || !env.DISCORD_WEBHOOK_URL) return "skipped";
  const key = `${kind === "pain follow-up" ? PAIN_FOLLOWUP_PREFIX : ANALYSED_PREFIX}${activity.id}`;
  // Pain before the analysis: the analysis (or the 20:35 check) will read it.
  if (kind === "pain follow-up" && !(await isAnalysed(env, activity.id))) return "skipped";
  if (await env.STATE.get(key)) return "skipped";
  await env.STATE.put(key, "1", { expirationTtl: FLAG_TTL_S });

  const result: FireResult = await dispatchAutomated(
    env,
    {
      kind,
      request: analysisRequest(activity, input, kind),
      weather: rideWeatherSection(env, now, fetchImpl),
      now,
      notice: `${kind === "pain follow-up" ? "🦵" : "🔍"} ${SECTION[kind]} (${activityLabel(activity)})`,
    },
    fetchImpl,
  ).catch((err) => ({ ok: false, status: 0, error: (err as Error).message }));
  if (result.ok) return "started";

  await env.STATE.delete(key);
  await postFireFailure(env, kind, result, fetchImpl).catch((err) =>
    console.error(`${kind}: failure notice failed:`, (err as Error).message),
  );
  return "failed";
}

/**
 * `/feedback`: save it and show the result (the deferred reply), then start the analysis when
 * the activity is from today or yesterday.
 */
export async function feedbackAndAnalyse(
  env: Env,
  interactionToken: string,
  input: FeedbackInput,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { message, activity } = await recordFeedback(env, input, now, fetchImpl);
  await editOriginal(env, interactionToken, message, fetchImpl);
  if (!activity || !isRecent(activity, now)) return;
  const line = analysisLine("activity analysis", await startAnalysis(env, activity, input, "activity analysis", now, fetchImpl));
  if (line) await editOriginal(env, interactionToken, `${message}\n${line}`, fetchImpl);
}
