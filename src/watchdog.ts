import { DISCORD_API, USER_AGENT, editOriginal, fetchRecentMessages, postWebhook } from "./discord.ts";
import type { DiscordMessage, Env } from "./types.ts";

/**
 * Notice when a coach run never answers (crash, discord-post failure, usage limit).
 * Each started run is stored in KV; the cron checks it after WATCHDOG_MINUTES (default 10)
 * and, if no Coach reply was posted since, adds a warning with the session link.
 * Automated runs (automated.ts) have no interaction token: their warning is a new message.
 * A run with `pin` gets its answer pinned (pinned messages survive the 24 h cleanup).
 */

const PREFIX = "pending:";

export interface PendingRun {
  token?: string; // interaction token: edits the ack (or the confirmed proposal) for 15 min; none for automated runs
  channelId: string;
  message: string; // current text of that message; the warning goes below it
  firedAt: number;
  sessionUrl?: string;
  pin?: string; // pin the answer, keeping only the latest per group ("weekly-review")
  pinPrefix?: string; // how that answer starts ("📈"); without it every Coach post since firedAt is pinned
}

// discord-post sends the parts of a long reply 0.6 s apart.
const PART_GAP_MS = 30_000;

function isCoachPost(m: DiscordMessage): boolean {
  return !!m.webhook_id && m.author?.username === "Coach";
}

/**
 * The ids (oldest first) of the answer to pin: the first Coach post since `firedAt` that starts
 * with `prefix`, plus the parts posted right after it. Without a prefix, every Coach post since.
 */
export function answerToPin(recent: DiscordMessage[], firedAt: number, prefix?: string): string[] {
  const since = [...recent].reverse().filter((m) => Date.parse(m.timestamp) > firedAt);
  if (!prefix) return since.filter(isCoachPost).map((m) => m.id);
  const start = since.findIndex((m) => isCoachPost(m) && (m.content ?? "").trimStart().startsWith(prefix));
  if (start === -1) return [];
  const ids = [since[start]!.id];
  for (let i = start + 1; i < since.length; i++) {
    const m = since[i]!;
    if (!isCoachPost(m) || Date.parse(m.timestamp) - Date.parse(since[i - 1]!.timestamp) > PART_GAP_MS) break;
    ids.push(m.id);
  }
  return ids;
}

/** "-# 🔗 [Cloud session](<url>)": a small line under the ack. `<…>` stops Discord's link preview. */
export function sessionLine(url: string): string {
  return `-# 🔗 [Cloud session](<${url}>)`;
}

export function warningLine(minutes: number, sessionUrl?: string): string {
  const where = sessionUrl ? `[open the session](<${sessionUrl}>)` : "check claude.ai/code/routines";
  return `⚠️ No answer after ${minutes} min. The run may have failed or still be busy: ${where}.`;
}

export async function trackRun(env: Env, id: string, run: PendingRun): Promise<void> {
  // Auto-expires, so a lost entry never warns twice or hangs around.
  await env.STATE?.put(`${PREFIX}${id}`, JSON.stringify(run), { expirationTtl: 3_600 });
}

/** Called from the cron. Returns how many warnings were posted. */
export async function checkPendingRuns(
  env: Env,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const minutes = Number(env.WATCHDOG_MINUTES ?? "10");
  if (!env.STATE || !(minutes > 0)) return 0;

  let warned = 0;
  for (const { name } of (await env.STATE.list({ prefix: PREFIX })).keys) {
    const raw = await env.STATE.get(name);
    if (!raw) continue;
    let run: PendingRun;
    try {
      run = JSON.parse(raw) as PendingRun;
    } catch {
      // A damaged entry would stop the check for every other run until it expires.
      console.error(`watchdog: dropping unreadable ${name}`);
      await env.STATE.delete(name);
      continue;
    }
    if (now - run.firedAt < minutes * 60_000) continue;

    const recent = await fetchRecentMessages(env, run.channelId, 20, fetchImpl);
    const answers = recent.filter((m) => isCoachPost(m) && Date.parse(m.timestamp) > run.firedAt);
    if (answers.length && run.pin) {
      const ids = answerToPin(recent, run.firedAt, run.pinPrefix);
      try {
        if (ids.length) await pinLatest(env, run.channelId, run.pin, ids, fetchImpl);
        else console.error(`pin: no Coach post starting with "${run.pinPrefix}" for ${run.pin}`);
      } catch (err) {
        console.error("pin failed:", (err as Error).message);
      }
    }
    if (!answers.length) {
      const warning = warningLine(minutes, run.sessionUrl);
      try {
        if (!run.token) throw new Error("no interaction token");
        await editOriginal(env, run.token, `${run.message}\n${warning}`, fetchImpl);
      } catch {
        // Interaction token expired (15 min), or an automated run: post it as a separate message instead.
        const content = run.token ? warning : `${run.message}\n${warning}`;
        await postWebhook(env, { username: "System", content }, fetchImpl);
      }
      warned++;
    }
    await env.STATE.delete(name);
  }
  return warned;
}

async function pinRequest(env: Env, channelId: string, id: string, method: "PUT" | "DELETE", fetchImpl: typeof fetch) {
  const res = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages/pins/${id}`, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(5_000),
  });
  // 404: the message is already gone, fine.
  if (!res.ok && res.status !== 404) {
    const hint = res.status === 403 ? " (give the bot Pin Messages in #coach)" : "";
    throw new Error(`Discord pin ${method} HTTP ${res.status}${hint}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Pin `ids` (oldest first) and unpin what was pinned for `group` before. */
export async function pinLatest(
  env: Env,
  channelId: string,
  group: string,
  ids: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = `pinned:${group}`;
  const previous = JSON.parse((await env.STATE?.get(key)) ?? "[]") as string[];
  for (const id of ids) await pinRequest(env, channelId, id, "PUT", fetchImpl);
  for (const id of previous.filter((p) => !ids.includes(p))) await pinRequest(env, channelId, id, "DELETE", fetchImpl);
  await env.STATE?.put(key, JSON.stringify(ids));
}
