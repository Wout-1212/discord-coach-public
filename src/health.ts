import { postWebhook } from "./discord.ts";
import type { Env } from "./types.ts";

/**
 * Cron jobs have nobody watching them, so a failure used to end up only in the logs.
 * runSafely counts failures in a row per job (KV). At `warnAfter` it posts one "System" warning
 * in #coach, stays quiet while the job keeps failing, and a success starts the count over.
 */

const PREFIX = "failing:";
const TTL_S = 3 * 86_400;

interface Failing {
  count: number;
  warned: boolean;
}

export function failureWarning(name: string, count: number, message: string): string {
  const times = count > 1 ? ` ${count} times in a row` : "";
  return `⚠️ The ${name} job failed${times}: ${message}\n-# No more warnings until it works again. Logs: \`npm run tail\`.`;
}

async function noteFailure(
  env: Env,
  name: string,
  message: string,
  warnAfter: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!env.STATE) return;
  const key = `${PREFIX}${name}`;
  const state = JSON.parse((await env.STATE.get(key)) ?? '{"count":0,"warned":false}') as Failing;
  state.count++;
  if (state.count >= warnAfter && !state.warned) {
    await env.STATE.put(key, JSON.stringify(state), { expirationTtl: TTL_S });
    await postWebhook(env, { username: "System", content: failureWarning(name, state.count, message) }, fetchImpl);
    state.warned = true; // only once it's posted: a failed post is tried again next time
  }
  await env.STATE.put(key, JSON.stringify(state), { expirationTtl: TTL_S });
}

/** Run a cron job. Never throws. `job` returns how much it did, for the logs. */
export async function runSafely(
  env: Env,
  name: string,
  job: () => Promise<number>,
  warnAfter = 3,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const count = await job();
    if (count) console.log(`${name}:`, count);
    if (await env.STATE?.get(`${PREFIX}${name}`)) await env.STATE?.delete(`${PREFIX}${name}`);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`${name} failed:`, message);
    await noteFailure(env, name, message, warnAfter, fetchImpl).catch((e) =>
      console.error("failure warning failed:", (e as Error).message),
    );
  }
}
