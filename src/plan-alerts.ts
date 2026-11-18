import { postWebhook } from "./discord.ts";
import { loadTrainingData, trainingGates } from "./history.ts";
import type { Env } from "./types.ts";

/**
 * 19:05: the plan check (plan-check.ts) on the calendar as it is, also after changes made in
 * Intervals by hand. Each problem is posted once (KV, 7 days); silent when all rules are met.
 */

export const PLAN_ALERT_TIME = "19:05";
const TTL_S = 7 * 86_400;

/** Called from the cron. Returns how many new problems were posted. */
export async function postPlanProblems(env: Env, now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!env.STATE || !env.DISCORD_WEBHOOK_URL || !env.INTERVALS_API_KEY) return 0;
  const data = await loadTrainingData(env, now, fetchImpl);
  if (!data.events) throw new Error("the calendar couldn't be read");
  const { problems = [] } = trainingGates(data, env);

  const fresh: string[] = [];
  for (const problem of problems) {
    if (!(await env.STATE.get(keyOf(problem)))) fresh.push(problem);
  }
  if (!fresh.length) return 0;
  await postWebhook(
    env,
    {
      username: "System",
      content: [
        "⚠️ **Plan check**: the calendar breaks a rule the Worker checks:",
        ...fresh.map((p) => `- ${p}`),
        "-# Ask `/coach fix the plan check`, or change it in Intervals. Each problem is posted once.",
      ].join("\n"),
    },
    fetchImpl,
  );
  for (const problem of fresh) await env.STATE.put(keyOf(problem), "1", { expirationTtl: TTL_S });
  return fresh.length;
}

// KV keys are at most 512 bytes; the problem text names the day and the session.
const keyOf = (problem: string) => `plancheck:${problem.slice(0, 300)}`;
