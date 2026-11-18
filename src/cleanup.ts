import { DISCORD_API, USER_AGENT } from "./discord.ts";
import type { DiscordMessage, Env } from "./types.ts";

const DISCORD_EPOCH = 1_420_070_400_000n;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// Discord's bulk delete only accepts messages younger than 14 days; keep an hour of margin.
const BULK_MAX_AGE_MS = 14 * 24 * 3_600_000 - 3_600_000;

/** Smallest message ID Discord could assign at `ms`: usable as a `before=` cursor for a point in time. */
export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n).toString();
}

async function discord(
  env: Env,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const res = await fetchImpl(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "User-Agent": USER_AGENT,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  // 404: already deleted, fine.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Discord ${init.method ?? "GET"} ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res;
}

/**
 * Delete messages in COACH_CHANNEL_ID older than DELETE_AFTER_HOURS (default 24).
 * Pinned messages are kept. Runs from the Worker's cron trigger; returns how many were deleted.
 */
export async function deleteOldMessages(
  env: Env,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const channelId = env.COACH_CHANNEL_ID?.trim() ?? "";
  const hours = Number(env.DELETE_AFTER_HOURS ?? "24");
  if (!/^\d+$/.test(channelId) || !(hours > 0)) return 0;

  // Only list messages from before the cutoff, newest first, paging backwards.
  const old: DiscordMessage[] = [];
  let before = snowflakeAt(now - hours * 3_600_000);
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await discord(
      env,
      `/channels/${channelId}/messages?limit=${PAGE_SIZE}&before=${before}`,
      {},
      fetchImpl,
    );
    const batch = (await res.json()) as DiscordMessage[];
    old.push(...batch.filter((m) => !m.pinned));
    const last = batch.at(-1);
    if (batch.length < PAGE_SIZE || !last) break;
    before = last.id;
  }

  const bulk = old.filter((m) => now - Date.parse(m.timestamp) < BULK_MAX_AGE_MS).map((m) => m.id);
  const single = old.filter((m) => now - Date.parse(m.timestamp) >= BULK_MAX_AGE_MS).map((m) => m.id);

  let deleted = 0;
  for (let i = 0; i < bulk.length; i += 100) {
    const ids = bulk.slice(i, i + 100);
    if (ids.length === 1) {
      single.unshift(...ids);
      continue;
    }
    await discord(
      env,
      `/channels/${channelId}/messages/bulk-delete`,
      { method: "POST", body: JSON.stringify({ messages: ids }) },
      fetchImpl,
    );
    deleted += ids.length;
  }
  // Messages older than 14 days (only if cleanup was off for a while) go one by one.
  // A rate limit throws; the rest is picked up on the next run.
  for (const id of single) {
    await discord(env, `/channels/${channelId}/messages/${id}`, { method: "DELETE" }, fetchImpl);
    deleted++;
  }
  return deleted;
}
