import { type FireResult, explainFireError, fireTask } from "./claude.ts";
import { editOriginal, fetchRecentMessages, formatHistory, postFollowup } from "./discord.ts";
import { historySection } from "./history.ts";
import { buildTaskText } from "./task-text.ts";
import type { Env, Interaction } from "./types.ts";
import { sessionLine, trackRun } from "./watchdog.ts";
import { rideWeatherSection } from "./weather.ts";

export interface CoachRequest {
  interaction: Interaction;
  question: string;
  ownerName: string;
  /** Text of the message the interaction token edits (the ack, or the confirmed proposal). */
  message: string;
  /** Set when the owner confirmed a proposal with the ✅ button. */
  proposal?: string;
}

/**
 * Start the coach task: read recent channel messages, fire the task, then add the session
 * link under the message and hand the run to the watchdog. On failure, post a notice.
 */
export async function dispatchToClaude(
  req: CoachRequest,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<FireResult> {
  const { interaction } = req;
  const weather = rideWeatherSection(env, new Date(), fetchImpl);
  const trainingHistory = historySection(env, new Date(), fetchImpl);
  let history = "";
  let historyNote: string | undefined;
  if (interaction.channel_id) {
    try {
      const messages = await fetchRecentMessages(
        env,
        interaction.channel_id,
        Number(env.HISTORY_LIMIT ?? "20") + 1, // +1: the current acknowledgement is skipped
        fetchImpl,
      );
      history = formatHistory(messages, {
        excludeInteractionId: interaction.id,
        applicationId: env.DISCORD_APPLICATION_ID,
        ownerName: req.ownerName,
      });
    } catch (err) {
      historyNote = "earlier messages could not be loaded, so follow-ups may lack context";
      console.error("history fetch failed:", (err as Error).message);
    }
  }

  const text = buildTaskText({
    question: req.question,
    ownerName: req.ownerName,
    history,
    historyNote,
    proposal: req.proposal,
    weather: await weather,
    trainingHistory: await trainingHistory,
  });
  const result = await fireTask(env, text, fetchImpl);

  if (result.ok) {
    console.log("task started:", result.sessionUrl);
    const message = result.sessionUrl ? `${req.message}\n${sessionLine(result.sessionUrl)}` : req.message;
    // Each on its own: a failed edit must not keep the run from the watchdog.
    if (interaction.channel_id) {
      await trackRun(env, interaction.id, {
        token: interaction.token,
        channelId: interaction.channel_id,
        message,
        firedAt: Date.now(),
        sessionUrl: result.sessionUrl,
      }).catch((err) => console.error("tracking the run failed:", (err as Error).message));
    }
    if (result.sessionUrl) {
      await editOriginal(env, interaction.token, message, fetchImpl).catch((err) =>
        console.error("adding the session link failed:", (err as Error).message),
      );
    }
    return result;
  }

  console.error("task fire failed:", result.status, result.error);
  try {
    await postFollowup(
      env,
      interaction.token,
      `⚠️ Couldn't start the coach (${result.error}). ${explainFireError(result)}`,
      fetchImpl,
    );
  } catch (err) {
    console.error("follow-up failed:", (err as Error).message);
  }
  return result;
}
