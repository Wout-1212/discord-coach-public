import { type FireResult, explainFireError, fireTask } from "./claude.ts";
import { fetchRecentMessages, formatHistory, postWebhook } from "./discord.ts";
import { historySection } from "./history.ts";
import { buildTaskText } from "./task-text.ts";
import { type Env, OWNER_NAME } from "./types.ts";
import { trackRun } from "./watchdog.ts";

/**
 * Start the coach task for the Worker itself (weather switches, scheduled briefs and reviews).
 * There's no interaction: the history comes from COACH_CHANNEL_ID, the run is marked
 * "automated" in its input, and the watchdog posts a warning as a new message if the run
 * never answers. A run that can't start gets a "System" notice in #coach.
 */
export async function dispatchAutomated(
  env: Env,
  run: {
    kind: string; // "weather check", "morning brief", …: shown to the coach and in notices
    request: string;
    weather: string | Promise<string>; // the ride weather block (weather.ts); a promise loads alongside the rest
    now: Date;
    /** First line of the watchdog warning, e.g. "🌦️ Weather switch (Sat 07 Nov)". */
    notice: string;
    /** Pin the answer, keeping only the latest one per group (e.g. "weekly-review"). */
    pin?: string;
    /** How the answer to pin starts ("📈"), so other Coach posts in the meantime stay unpinned. */
    pinPrefix?: string;
    /** False = the run may post nothing, so the watchdog doesn't wait for an answer. */
    track?: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<FireResult> {
  const trainingHistory = historySection(env, run.now, fetchImpl);
  let history = "";
  if (env.COACH_CHANNEL_ID) {
    try {
      const messages = await fetchRecentMessages(env, env.COACH_CHANNEL_ID, Number(env.HISTORY_LIMIT ?? "20"), fetchImpl);
      history = formatHistory(messages, { applicationId: env.DISCORD_APPLICATION_ID, ownerName: OWNER_NAME });
    } catch (err) {
      console.error("history fetch failed:", (err as Error).message);
    }
  }
  const text = buildTaskText({
    question: run.request,
    ownerName: OWNER_NAME,
    automated: run.kind,
    history,
    weather: await run.weather,
    trainingHistory: await trainingHistory,
    now: run.now,
  });
  const result = await fireTask(env, text, fetchImpl);

  if (!result.ok) {
    console.error(`${run.kind}: task fire failed:`, result.status, result.error);
    return result;
  }
  console.log(`${run.kind}: task started:`, result.sessionUrl);
  if (env.COACH_CHANNEL_ID && run.track !== false) {
    await trackRun(env, `${run.kind.replace(/\W+/g, "-")}-${run.now.getTime()}`, {
      channelId: env.COACH_CHANNEL_ID,
      message: run.notice,
      firedAt: run.now.getTime(),
      sessionUrl: result.sessionUrl,
      pin: run.pin,
      pinPrefix: run.pinPrefix,
    });
  }
  return result;
}

/** "⚠️ Couldn't start the morning brief (…). <advice>" as a "System" post. */
export async function postFireFailure(env: Env, kind: string, result: FireResult, fetchImpl: typeof fetch = fetch) {
  await postWebhook(
    env,
    { username: "System", content: `⚠️ Couldn't start the ${kind} (${result.error}). ${explainFireError(result)}` },
    fetchImpl,
  );
}
