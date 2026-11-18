import { editOriginal, postFollowup, postWebhook } from "./discord.ts";
import { type AnalysisKind, analysisLine, startAnalysis } from "./analysis.ts";
import { FEEL_LABELS, type FeedbackInput, activityLabel, recordFeedback } from "./feedback.ts";
import { type IntervalsActivity, listActivityMessages, listRecentActivities } from "./intervals.ts";
import { descriptionNotes, messageNotes } from "./notes.ts";
import { formatDuration, sportEmoji } from "./plan.ts";
import { type Env, type Interaction, buttonRow } from "./types.ts";

/**
 * New-activity nudges. The cron looks for activities from today and yesterday without
 * feedback and posts one message per activity in #coach (as "Intervals"), with feel buttons
 * and a note button. A feel tap saves it on the activity, like `/feedback feel:…`. The note
 * button opens a pop-up for RPE and notes, saved the same way. Runs also get a 🦵 pain button:
 * nothing asks about pain, it's there for when Wout wants to report it. Each activity is nudged
 * once (remembered in KV). Sending the note pop-up starts the coach's analysis of the activity,
 * and a pain report after that analysis a follow-up (analysis.ts).
 */

const FEEL_PREFIX = "feel:";
const NOTE_PREFIX = "note:";
const PAIN_PREFIX = "pain:";
const RPE_FIELD = "rpe";
const NOTES_FIELD = "notes";
// Five fields at most in a pop-up, so the button itself is the "any pain?" question.
const PAIN_FIELDS = {
  where: { label: "Where?", required: true, options: ["calf", "Achilles", "shin", "knee", "foot/ankle", "other"] },
  severity: { label: "How bad?", required: true, options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] },
  when: { label: "When?", required: false, options: ["during", "right after", "next morning"] },
  trend: { label: "Compared with before", required: false, options: ["better", "same", "worse"] },
  effect: { label: "Did it change your run?", required: false, options: ["no change", "changed how I ran", "had to stop"] },
} as const;
const ASK_LINE = "How did it feel? Tap one, and add your RPE and a note with 📝.";
const NOTE_HINT = "Add your RPE and a note with 📝: the coach analyses it once you send it.";
const NUDGED_TTL_S = 4 * 86_400;
// No pings at night: activities that sync then are nudged in the morning.
const QUIET_FROM_HOUR = 22;
const QUIET_UNTIL_HOUR = 7;

const brusselsHour = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Brussels",
  hour: "2-digit",
  hourCycle: "h23",
});

/** Feel, RPE, or (older activities) a Feedback:/Pain: line in the description. Messages: `hasNoteMessage`. */
export function hasFeedback(a: IntervalsActivity): boolean {
  return !!a.feel || !!a.icu_rpe || descriptionNotes(a.description).length > 0;
}

async function hasNoteMessage(env: Env, a: IntervalsActivity, fetchImpl: typeof fetch): Promise<boolean> {
  const notes = messageNotes(await listActivityMessages(env, a.id, fetchImpl));
  return notes.some((n) => n.kind === "feedback" || n.kind === "pain");
}

export function nudgeMessage(a: IntervalsActivity) {
  const stats = [
    a.moving_time ? formatDuration(a.moving_time) : "",
    a.icu_training_load ? `${Math.round(a.icu_training_load)} load` : "",
  ].filter(Boolean);
  const lines = [`${sportEmoji(a.type)} New activity: **${activityLabel(a)}**`];
  if (stats.length) lines.push(stats.join(" · "));
  lines.push(ASK_LINE);
  return {
    content: lines.join("\n"),
    components: [
      buttonRow(FEEL_LABELS.map((label, i) => ({ style: 2, label, custom_id: `${FEEL_PREFIX}${a.id}:${i + 1}` }))),
      buttonRow([{ style: 1, label: "📝 RPE + note", custom_id: `${NOTE_PREFIX}${a.id}` }]),
      ...(a.type?.includes("Run") ? [buttonRow([{ style: 2, label: "🦵 Pain", custom_id: `${PAIN_PREFIX}${a.id}` }])] : []),
    ],
  };
}

/** Called from the cron. Returns how many nudges were posted. */
export async function nudgeNewActivities(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!env.STATE || !env.DISCORD_WEBHOOK_URL || !env.INTERVALS_API_KEY) return 0;
  const hour = Number(brusselsHour.format(now));
  if (hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR) return 0;

  let sent = 0;
  const activities = await listRecentActivities(env, now, 1, fetchImpl);
  for (const a of activities.reverse()) {
    if (hasFeedback(a)) continue;
    const key = `nudged:${a.id}`;
    if (await env.STATE.get(key)) continue;
    if (await hasNoteMessage(env, a, fetchImpl)) continue;
    await postWebhook(env, { username: "Intervals", ...nudgeMessage(a) }, fetchImpl);
    await env.STATE.put(key, "1", { expirationTtl: NUDGED_TTL_S });
    sent++;
  }
  return sent;
}

export function isFeelButton(customId: string | undefined): boolean {
  return !!customId?.startsWith(FEEL_PREFIX);
}

/** True for the note button and for the pop-up it opens: both carry the same custom_id. */
export function isNote(customId: string | undefined): boolean {
  return !!customId?.startsWith(NOTE_PREFIX);
}

/** True for the pain button and for the pop-up it opens. */
export function isPain(customId: string | undefined): boolean {
  return !!customId?.startsWith(PAIN_PREFIX);
}

/** The pop-up the note button opens. Both fields are optional. */
export function noteModal(customId: string) {
  const rpeLabels: Record<number, string> = { 1: "1 · Very easy", 5: "5 · Hard", 10: "10 · Max" };
  return {
    custom_id: customId,
    title: "How did it go?",
    components: [
      {
        type: 18, // label
        label: "RPE (effort)",
        component: {
          type: 3, // string select
          custom_id: RPE_FIELD,
          placeholder: "Pick 1 to 10",
          required: false,
          options: Array.from({ length: 10 }, (_, i) => ({ label: rpeLabels[i + 1] ?? String(i + 1), value: String(i + 1) })),
        },
      },
      {
        type: 18,
        label: "Note",
        component: {
          type: 4, // text input
          custom_id: NOTES_FIELD,
          style: 2, // paragraph
          placeholder: "Legs, energy, pain, conditions…",
          max_length: 1000,
          required: false,
        },
      },
    ],
  };
}

/** What was filled in. */
export function readNote(interaction: Interaction): { rpe?: number; notes?: string } {
  const fields = (interaction.data?.components ?? []).map((label) => label.component);
  const rpe = Number(fields.find((f) => f?.custom_id === RPE_FIELD)?.values?.[0]);
  const notes = fields.find((f) => f?.custom_id === NOTES_FIELD)?.value?.trim();
  return { rpe: rpe >= 1 && rpe <= 10 ? rpe : undefined, notes: notes || undefined };
}

/** The pop-up the pain button opens. */
export function painModal(customId: string) {
  return {
    custom_id: customId,
    title: "Report pain",
    components: Object.entries(PAIN_FIELDS).map(([id, field]) => ({
      type: 18, // label
      label: field.label,
      component: {
        type: 3, // string select
        custom_id: id,
        required: field.required,
        options: field.options.map((option) => ({ label: option, value: option })),
      },
    })),
  };
}

/** "calf 3/10, during, same, changed how I ran"; undefined without a place and a severity. */
export function readPain(interaction: Interaction): string | undefined {
  const fields = (interaction.data?.components ?? []).map((label) => label.component);
  const value = (id: keyof typeof PAIN_FIELDS) => fields.find((f) => f?.custom_id === id)?.values?.[0];
  const [where, severity] = [value("where"), value("severity")];
  if (!where || !severity) return undefined;
  return [`${where} ${severity}/10`, value("when"), value("trend"), value("effect")].filter(Boolean).join(", ");
}

/** The button rows of the tapped message, without the row whose buttons start with `prefix`. */
function rowsWithout(interaction: Interaction, prefix: string): unknown[] {
  const rows = (interaction.message?.components ?? []) as { components?: { custom_id?: string }[] }[];
  return rows.filter((row) => !row.components?.some((button) => button.custom_id?.startsWith(prefix)));
}

function hasRow(rows: unknown[], prefix: string): boolean {
  return (rows as { components?: { custom_id?: string }[] }[]).some((row) =>
    row.components?.some((button) => button.custom_id?.startsWith(prefix)),
  );
}

function messageLines(interaction: Interaction): string[] {
  return (interaction.message?.content ?? "").split("\n").filter((line) => line !== ASK_LINE);
}

/**
 * Save what a pop-up sent (after a deferred update), show the result on the nudge, then start
 * the coach: the note pop-up starts the analysis, a pain report after it a follow-up.
 */
async function saveFromModal(
  env: Env,
  interaction: Interaction,
  prefix: string,
  input: Omit<FeedbackInput, "activityId">,
  kind: AnalysisKind,
  fetchImpl: typeof fetch,
): Promise<void> {
  const activityId = (interaction.data?.custom_id ?? "").slice(prefix.length);
  const now = new Date();
  const { message, activity } = await recordFeedback(env, { activityId, ...input }, now, fetchImpl);
  if (!activity) {
    // Failed: leave the buttons for a retry and show why.
    await postFollowup(env, interaction.token, message, fetchImpl);
    return;
  }
  const lines = [...messageLines(interaction), message];
  const rows = rowsWithout(interaction, prefix);
  await editOriginal(env, interaction.token, lines.join("\n"), fetchImpl, rows);

  const line = analysisLine(kind, await startAnalysis(env, activity, input, kind, now, fetchImpl));
  if (line) await editOriginal(env, interaction.token, [...lines, line].join("\n"), fetchImpl, rows);
}

export function saveNoteFromModal(env: Env, interaction: Interaction, fetchImpl: typeof fetch = fetch): Promise<void> {
  return saveFromModal(env, interaction, NOTE_PREFIX, readNote(interaction), "activity analysis", fetchImpl);
}

export function savePainFromModal(env: Env, interaction: Interaction, fetchImpl: typeof fetch = fetch): Promise<void> {
  return saveFromModal(env, interaction, PAIN_PREFIX, { pain: readPain(interaction) }, "pain follow-up", fetchImpl);
}

/** A feel button was tapped (after a deferred update): save it and replace the feel buttons with the result. */
export async function saveFeelFromButton(
  env: Env,
  interaction: Interaction,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const [activityId = "", value = ""] = (interaction.data?.custom_id ?? "").slice(FEEL_PREFIX.length).split(":");
  const feel = Number(value);
  if (!(feel >= 1 && feel <= 5)) return;
  const { message, activity } = await recordFeedback(env, { activityId, feel }, new Date(), fetchImpl);
  if (!activity) {
    // Failed: leave the buttons for a retry and show why.
    await postFollowup(env, interaction.token, message, fetchImpl);
    return;
  }
  const rows = rowsWithout(interaction, FEEL_PREFIX);
  const saved = `📝 Feel saved: **${FEEL_LABELS[feel - 1]}** (${feel}/5).${hasRow(rows, NOTE_PREFIX) ? ` ${NOTE_HINT}` : ""}`;
  const lines = [...messageLines(interaction), saved];
  await editOriginal(env, interaction.token, lines.join("\n"), fetchImpl, rows);
}
