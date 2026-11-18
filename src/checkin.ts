import { editOriginal, postFollowup, postWebhook } from "./discord.ts";
import { NEXT_MORNING_PREFIX } from "./feedback.ts";
import { FATIGUE_LABELS } from "./history.ts";
import { addDays, brusselsDate, listRecentActivities, postActivityMessage, updateWellness } from "./intervals.ts";
import { openPain } from "./ladder.ts";
import { NEXT_MORNING_ANSWERS, type NextMorning, recentNotes } from "./notes.ts";
import { dayLabel, dayOf, sportOf } from "./sessions.ts";
import { type Env, type Interaction, buttonRow } from "./types.ts";

/**
 * The morning check (08:00, as "Check-in"): how Wout feels (Intervals wellness `fatigue`,
 * 1 = low … 4 = extreme) and, after a run yesterday or while a pain report is open, how the
 * legs are (a "Next morning (…): same" message on that run: the next-morning half of the pain
 * rule, which the ladder gate reads). One tap each; the 10:00 brief reads both. Unanswered = nothing.
 */

export const CHECK_TIME = "08:00";
const PREFIX = "checkin:";
const FEEL = `${PREFIX}feel:`;
const LEGS = `${PREFIX}legs:`;
const FEEL_QUESTION = "How do you feel this morning?";
const LEGS_QUESTION = "Legs this morning";
const DONE_TTL_S = 2 * 86_400;
const PAIN_LOOKBACK_DAYS = 14;
const LEGS_BUTTONS: [NextMorning, string][] = [
  ["none", "No pain"],
  ["better", "Better"],
  ["same", "Same"],
  ["worse", "Worse"],
];

export function isCheckin(customId: string | undefined): boolean {
  return !!customId?.startsWith(PREFIX);
}

/** Called from the cron at CHECK_TIME. Returns 1 when it posted. */
export async function postMorningCheck(env: Env, now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!env.STATE || !env.DISCORD_WEBHOOK_URL || !env.INTERVALS_API_KEY) return 0;
  const today = brusselsDate.format(now);
  const key = `checkin:${today}`;
  if (await env.STATE.get(key)) return 0;

  const activities = await listRecentActivities(env, now, PAIN_LOOKBACK_DAYS, fetchImpl);
  const runs = activities.filter((a) => sportOf(a) === "run");
  const run = runs[0];
  let askLegs = !!run && dayOf(run) === addDays(today, -1);
  if (run && !askLegs) askLegs = !!openPain(runs, await recentNotes(env, runs, today, PAIN_LOOKBACK_DAYS, fetchImpl), today);

  const lines = [`☀️ **Morning check · ${dayLabel(today)}**`, FEEL_QUESTION];
  const components = [buttonRow(FATIGUE_LABELS.map((label, i) => ({ style: 2, label, custom_id: `${FEEL}${today}:${i + 1}` })))];
  if (run && askLegs) {
    lines.push(`${LEGS_QUESTION}, after the ${dayLabel(dayOf(run))} run?`);
    components.push(buttonRow(LEGS_BUTTONS.map(([value, label]) => ({ style: 2, label, custom_id: `${LEGS}${run.id}:${value}` }))));
  }
  lines.push("-# One tap each. The 10:00 brief reads it; skipping is fine.");
  await postWebhook(env, { username: "Check-in", content: lines.join("\n"), components }, fetchImpl);
  await env.STATE.put(key, "1", { expirationTtl: DONE_TTL_S });
  return 1;
}

/** A morning-check button was tapped (after a deferred update): save it, then replace that row. */
export async function saveCheckin(env: Env, interaction: Interaction, fetchImpl: typeof fetch = fetch): Promise<void> {
  const customId = interaction.data?.custom_id ?? "";
  const feel = customId.startsWith(FEEL);
  const [target = "", value = ""] = customId.slice(feel ? FEEL.length : LEGS.length).split(":");
  let saved: string;
  try {
    if (feel) {
      const fatigue = Number(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(target) || !(fatigue >= 1 && fatigue <= 4)) return;
      await updateWellness(env, target, { fatigue }, fetchImpl);
      saved = `✅ Feel saved: **${FATIGUE_LABELS[fatigue - 1]}**`;
    } else {
      const answer = NEXT_MORNING_ANSWERS[value as NextMorning];
      if (!answer || !/^i?\d+$/.test(target)) return;
      const today = brusselsDate.format(new Date());
      await postActivityMessage(env, target, `${NEXT_MORNING_PREFIX} (${dayLabel(today)}): ${answer}`, fetchImpl);
      saved = `✅ Legs saved: **${answer}**${value === "worse" ? ". Worse than yesterday: the pain rule applies, the brief adjusts today." : ""}`;
    }
  } catch (err) {
    console.error("morning check failed:", (err as Error).message);
    await postFollowup(env, interaction.token, `⚠️ Couldn't save it (${(err as Error).message}). Tap again in a minute.`, fetchImpl);
    return;
  }

  const prefix = feel ? FEEL : LEGS;
  const question = feel ? FEEL_QUESTION : LEGS_QUESTION;
  const rows = ((interaction.message?.components ?? []) as { components?: { custom_id?: string }[] }[]).filter(
    (row) => !row.components?.some((b) => b.custom_id?.startsWith(prefix)),
  );
  const lines = (interaction.message?.content ?? "").split("\n").filter((line) => !line.startsWith(question));
  const footer = lines.findIndex((line) => line.startsWith("-# "));
  lines.splice(footer === -1 ? lines.length : footer, 0, saved);
  await editOriginal(env, interaction.token, lines.join("\n"), fetchImpl, rows);
}
