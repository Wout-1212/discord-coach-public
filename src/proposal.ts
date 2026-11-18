import { dispatchToClaude } from "./dispatch.ts";
import { editOriginal } from "./discord.ts";
import { type Ctx, type Env, type Interaction, ResponseType, buttonRow } from "./types.ts";

/**
 * ✅ Confirm / Cancel buttons under Coach proposals. The task adds them with
 * `discord-post --confirm` (cloud/discord-post builds the same custom_ids).
 *
 * ✅ starts the coach task with that exact proposal quoted, so a confirmation is tied to the
 * message you tapped, not to "whatever the Coach said last". Cancel only marks it cancelled.
 * Buttons disappear after the first tap; `/coach yes` keeps working as before.
 *
 * The status line goes above the proposal: long messages are cut at the end (here and in the
 * channel history), and the coach needs that line to know a proposal is closed.
 */

export const CONFIRM_ID = "proposal:confirm";
export const CANCEL_ID = "proposal:cancel";
// #coach messages are deleted after 24 h anyway; an older proposal is stale.
const MAX_AGE_MS = 24 * 3_600_000;
// A confirmed proposal still gets the session link and maybe a watchdog warning below it.
const MAX_CONFIRMED_CHARS = 1_600;

export const CONFIRMED_LINE = "✅ **Confirmed.** Applying it now…";
export const CANCELLED_LINE = "❌ **Cancelled.** Nothing was changed.";

export function proposalButtons() {
  return [
    buttonRow([
      { style: 3, label: "✅ Confirm", custom_id: CONFIRM_ID },
      { style: 2, label: "Cancel", custom_id: CANCEL_ID },
    ]),
  ];
}

function update(content: string, components: unknown[] = []): Response {
  return Response.json({
    type: ResponseType.UpdateMessage,
    data: { content, components, allowed_mentions: { parse: [] } },
  });
}

export async function handleProposalClick(
  interaction: Interaction,
  ownerName: string,
  env: Env,
  ctx: Ctx,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const proposal = interaction.message;
  if (!proposal) return Response.json({ type: ResponseType.DeferredUpdateMessage });

  if (Date.now() - Date.parse(proposal.timestamp) > MAX_AGE_MS) {
    return update(`${proposal.content}\n\n⌛ Expired. Ask again with \`/coach\`.`);
  }

  // Two quick taps can both arrive before the buttons are gone; only the first one counts.
  const lock = `clicked:${proposal.id}`;
  if (await env.STATE?.get(lock)) return update(proposal.content);
  await env.STATE?.put(lock, "1", { expirationTtl: 86_400 });

  if (interaction.data?.custom_id === CANCEL_ID) {
    return update(`${CANCELLED_LINE}\n\n${proposal.content}`);
  }

  const shown =
    proposal.content.length <= MAX_CONFIRMED_CHARS ? proposal.content : `${proposal.content.slice(0, MAX_CONFIRMED_CHARS)}…`;
  const message = `${CONFIRMED_LINE}\n\n${shown}`;
  ctx.waitUntil(
    dispatchToClaude(
      {
        interaction,
        question: "✅ Confirmed: carry out the proposal below.",
        ownerName,
        message,
        proposal: proposal.content,
      },
      env,
      fetchImpl,
    )
      .then(async (result) => {
        if (result.ok) return;
        // Put the buttons back so a retry is one tap (the error notice is posted separately).
        await env.STATE?.delete(lock);
        await editOriginal(env, interaction.token, proposal.content, fetchImpl, proposalButtons());
      })
      .catch((err) => console.error("confirm failed:", (err as Error).message)),
  );
  return update(message);
}
