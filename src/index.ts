import { deleteOldMessages } from "./cleanup.ts";
import { dispatchToClaude } from "./dispatch.ts";
import { buildAck, editOriginal } from "./discord.ts";
import { feedbackAndAnalyse } from "./analysis.ts";
import { activityChoices, readFeedbackOptions } from "./feedback.ts";
import { runSafely } from "./health.ts";
import {
  isFeelButton,
  isNote,
  isPain,
  noteModal,
  nudgeNewActivities,
  painModal,
  readNote,
  readPain,
  saveFeelFromButton,
  saveNoteFromModal,
  savePainFromModal,
} from "./nudge.ts";
import { readPlanDay, showPlan } from "./plan.ts";
import { CANCEL_ID, CONFIRM_ID, handleProposalClick } from "./proposal.ts";
import { reportRequest } from "./report.ts";
import { showStatus } from "./status.ts";
import {
  type Ctx,
  type Env,
  type Interaction,
  InteractionType,
  MessageFlags,
  OWNER_NAME,
  ResponseType,
} from "./types.ts";
import { verifyDiscordRequest } from "./verify.ts";
import { brusselsSlot, dueTasks, runScheduledTasks } from "./scheduled.ts";
import { CHECK_TIME, isCheckin, postMorningCheck, saveCheckin } from "./checkin.ts";
import { PLAN_ALERT_TIME, postPlanProblems } from "./plan-alerts.ts";
import { checkPendingRuns } from "./watchdog.ts";
import { checkRideWeather, isWeatherCheckTime } from "./weather.ts";

/**
 * `/feedback`, `/plan` and `/status` are handled here directly (Intervals API, no Claude run).
 * Buttons: ✅ Confirm / Cancel under Coach proposals (proposal.ts), feel, note and pain buttons
 * under activity nudges (nudge.ts). `/report` is a `/coach` run with a fixed request (report.ts).
 * The note pop-up and `/feedback` also start the coach on that activity (analysis.ts).
 *
 * Flow for `/coach <message>`:
 *  1. verify Discord's signature and that the sender is you (ALLOWED_USER_ID)
 *  2. answer Discord within 3 s with an acknowledgement (your question, quoted)
 *  3. in the background: read recent channel messages, start the Claude task, add the
 *     session link under the ack (dispatch.ts)
 *  4. the Claude task posts its answer to the channel itself (webhook); if it doesn't,
 *     the cron's watchdog adds a warning (watchdog.ts)
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ephemeral(content: string): Response {
  return json({
    type: ResponseType.ChannelMessage,
    data: { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } },
  });
}

/** Reply later (Intervals can take longer than Discord's 3 s): "thinking…", then edited. */
function deferred(env: Env, ctx: Ctx, interaction: Interaction, work: Promise<string>, fetchImpl: typeof fetch): Response {
  ctx.waitUntil(
    work
      .then((message) => editOriginal(env, interaction.token, message, fetchImpl))
      .catch((err) => console.error(`${interaction.data?.name} reply failed:`, (err as Error).message)),
  );
  return json({ type: ResponseType.DeferredChannelMessage });
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: Ctx,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return new Response("discord-coach is running. Discord sends interactions to /interactions.");
  }
  if (request.method !== "POST" || url.pathname !== "/interactions") {
    return new Response("Not found", { status: 404 });
  }

  const rawBody = await request.text();
  const valid = await verifyDiscordRequest(
    rawBody,
    request.headers.get("X-Signature-Ed25519"),
    request.headers.get("X-Signature-Timestamp"),
    env.DISCORD_PUBLIC_KEY,
  );
  if (!valid) return new Response("Bad request signature", { status: 401 });

  let interaction: Interaction;
  try {
    interaction = JSON.parse(rawBody) as Interaction;
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  if (interaction.type === InteractionType.Ping) {
    return json({ type: ResponseType.Pong });
  }

  const user = interaction.member?.user ?? interaction.user;
  const isOwner = !!user && user.id === env.ALLOWED_USER_ID;

  if (interaction.type === InteractionType.Autocomplete) {
    const typed = interaction.data?.options?.find((o) => o.focused)?.value;
    const choices =
      isOwner && interaction.data?.name === "feedback"
        ? await activityChoices(env, String(typed ?? ""), new Date(), fetchImpl)
        : [];
    return json({ type: ResponseType.AutocompleteResult, data: { choices } });
  }

  if (interaction.type === InteractionType.MessageComponent) {
    if (!isOwner) return ephemeral("This coach is private.");
    const customId = interaction.data?.custom_id;
    if (customId === CONFIRM_ID || customId === CANCEL_ID) {
      return handleProposalClick(interaction, OWNER_NAME, env, ctx, fetchImpl);
    }
    if (isFeelButton(customId)) {
      ctx.waitUntil(
        saveFeelFromButton(env, interaction, fetchImpl).catch((err) =>
          console.error("feel button failed:", (err as Error).message),
        ),
      );
      return json({ type: ResponseType.DeferredUpdateMessage });
    }
    if (isCheckin(customId)) {
      ctx.waitUntil(
        saveCheckin(env, interaction, fetchImpl).catch((err) => console.error("morning check tap failed:", (err as Error).message)),
      );
      return json({ type: ResponseType.DeferredUpdateMessage });
    }
    if (isNote(customId)) {
      return json({ type: ResponseType.Modal, data: noteModal(customId!) });
    }
    if (isPain(customId)) {
      return json({ type: ResponseType.Modal, data: painModal(customId!) });
    }
    return ephemeral("Unknown button.");
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    if (!isOwner) return ephemeral("This coach is private.");
    if (isPain(interaction.data?.custom_id)) {
      if (!readPain(interaction)) return ephemeral("Nothing saved: pick where it hurts and how bad it is.");
      ctx.waitUntil(
        savePainFromModal(env, interaction, fetchImpl).catch((err) =>
          console.error("pain report failed:", (err as Error).message),
        ),
      );
      return json({ type: ResponseType.DeferredUpdateMessage });
    }
    if (!isNote(interaction.data?.custom_id)) return ephemeral("Unknown form.");
    const note = readNote(interaction);
    if (!note.rpe && !note.notes) return ephemeral("Nothing saved: pick an RPE or write a note.");
    ctx.waitUntil(
      saveNoteFromModal(env, interaction, fetchImpl).catch((err) =>
        console.error("note failed:", (err as Error).message),
      ),
    );
    return json({ type: ResponseType.DeferredUpdateMessage });
  }

  const command = interaction.type === InteractionType.ApplicationCommand ? interaction.data?.name : undefined;
  if (
    command !== "coach" &&
    command !== "feedback" &&
    command !== "plan" &&
    command !== "report" &&
    command !== "status"
  ) {
    return ephemeral("Unknown command.");
  }
  if (!user || !isOwner) {
    return ephemeral("This coach is private.");
  }

  if (command === "status") {
    return deferred(env, ctx, interaction, showStatus(env, new Date(), fetchImpl), fetchImpl);
  }

  if (command === "plan") {
    const day = readPlanDay(interaction.data?.options);
    return deferred(env, ctx, interaction, showPlan(env, day, new Date(), fetchImpl), fetchImpl);
  }

  if (command === "feedback") {
    const input = readFeedbackOptions(interaction.data?.options);
    if (!input.feel && !input.rpe && !input.notes) {
      return ephemeral("Add at least one of `feel`, `rpe` or `notes`, e.g. `/feedback feel:Good rpe:6`.");
    }
    // Saved, shown, then the analysis starts (analysis.ts), so the reply doesn't wait for it.
    ctx.waitUntil(
      feedbackAndAnalyse(env, interaction.token, input, new Date(), fetchImpl).catch((err) =>
        console.error("feedback reply failed:", (err as Error).message),
      ),
    );
    return json({ type: ResponseType.DeferredChannelMessage });
  }

  const question =
    command === "report"
      ? reportRequest(interaction.data?.options)
      : String(interaction.data?.options?.find((o) => o.name === "message")?.value ?? "").trim();
  if (!question) {
    return ephemeral(
      command === "report"
        ? "Pick a report type from the list."
        : "Type a message after /coach, e.g. `/coach analyse today's ride`.",
    );
  }

  const ack = buildAck(question);
  ctx.waitUntil(
    dispatchToClaude({ interaction, question, ownerName: OWNER_NAME, message: ack }, env, fetchImpl).catch((err) =>
      console.error("dispatch failed:", (err as Error).message),
    ),
  );

  return json({
    type: ResponseType.ChannelMessage,
    data: { content: ack, allowed_mentions: { parse: [] } },
  });
}

/**
 * Cron, every 5 minutes (wrangler.jsonc "triggers"). Weather check at 06:30 and 19:00; scheduled
 * tasks (scheduled.ts). Those two aren't retried, so a single failure already warns (health.ts).
 */
export async function scheduled(scheduledTime: number, env: Env): Promise<void> {
  const minute = new Date(scheduledTime).getUTCMinutes();
  const jobs = [runSafely(env, "watchdog", () => checkPendingRuns(env, scheduledTime))];
  if (minute % 15 < 5) {
    jobs.push(runSafely(env, "activity nudges", () => nudgeNewActivities(env, new Date(scheduledTime))));
  }
  if (minute < 5) {
    jobs.push(runSafely(env, "cleanup", () => deleteOldMessages(env, scheduledTime)));
  }
  if (dueTasks(new Date(scheduledTime)).length) {
    jobs.push(runSafely(env, "scheduled tasks", () => runScheduledTasks(env, new Date(scheduledTime)), 1));
  }
  if (isWeatherCheckTime(new Date(scheduledTime))) {
    jobs.push(runSafely(env, "weather check", () => checkRideWeather(env, new Date(scheduledTime)), 1));
  }
  const slot = brusselsSlot(new Date(scheduledTime));
  if (slot === CHECK_TIME) {
    jobs.push(runSafely(env, "morning check", () => postMorningCheck(env, new Date(scheduledTime)), 1));
  }
  if (slot === PLAN_ALERT_TIME) {
    jobs.push(runSafely(env, "plan check", () => postPlanProblems(env, new Date(scheduledTime)), 1));
  }
  await Promise.all(jobs);
}

export default {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  scheduled(controller: { scheduledTime: number }, env: Env, ctx: Ctx): void {
    ctx.waitUntil(scheduled(controller.scheduledTime, env));
  },
};
