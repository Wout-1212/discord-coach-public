import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteOldMessages, snowflakeAt } from "../src/cleanup.ts";
import type { DiscordMessage } from "../src/types.ts";
import { makeEnv, makeFetch } from "./helpers.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const HOUR = 3_600_000;
const author = { id: "app-1", username: "Coach" };

function msg(id: string, hoursAgo: number, extra: Partial<DiscordMessage> = {}): DiscordMessage {
  return { id, content: "x", timestamp: new Date(NOW - hoursAgo * HOUR).toISOString(), author, ...extra };
}

function env(overrides: Record<string, string> = {}) {
  return { ...makeEnv("00"), COACH_CHANNEL_ID: "123", DELETE_AFTER_HOURS: "24", ...overrides };
}

test("snowflakeAt matches Discord's ID layout", () => {
  // Discord's docs example: 175928847299117063 was created 2016-04-30T11:18:25.796Z.
  assert.equal(BigInt(snowflakeAt(Date.parse("2016-04-30T11:18:25.796Z"))) >> 22n, 175928847299117063n >> 22n);
});

test("deletes old messages, keeps pinned ones, uses bulk delete under 14 days", async () => {
  const old = [msg("30", 25), msg("20", 30, { pinned: true }), msg("10", 48), msg("5", 15 * 24)];
  const { fetchImpl, calls } = makeFetch((call) =>
    call.method === "GET" ? Response.json(old) : new Response(null, { status: 204 }),
  );

  const deleted = await deleteOldMessages(env(), NOW, fetchImpl);

  assert.equal(deleted, 3);
  const [list, bulk, single, ...rest] = calls;
  assert.equal(rest.length, 0);
  assert.ok(list?.url.includes(`/channels/123/messages?limit=100&before=${snowflakeAt(NOW - 24 * HOUR)}`));
  assert.equal(list?.headers.authorization, "Bot bot-token");
  assert.equal(bulk?.method, "POST");
  assert.ok(bulk?.url.endsWith("/channels/123/messages/bulk-delete"));
  assert.deepEqual(JSON.parse(bulk?.body ?? "{}"), { messages: ["30", "10"] });
  assert.equal(single?.method, "DELETE");
  assert.ok(single?.url.endsWith("/channels/123/messages/5"));
});

test("a single recent message is deleted on its own (bulk delete needs 2+)", async () => {
  const { fetchImpl, calls } = makeFetch((call) =>
    call.method === "GET" ? Response.json([msg("7", 30)]) : new Response(null, { status: 204 }),
  );
  assert.equal(await deleteOldMessages(env(), NOW, fetchImpl), 1);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "DELETE"],
  );
});

test("pages backwards until a short page", async () => {
  const full = Array.from({ length: 100 }, (_, i) => msg(String(1000 - i), 30 + i));
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.method !== "GET") return new Response(null, { status: 204 });
    return Response.json(call.url.includes("before=901") ? [msg("900", 200)] : full);
  });
  assert.equal(await deleteOldMessages(env(), NOW, fetchImpl), 101);
  assert.equal(calls.filter((c) => c.method === "GET").length, 2);
});

test("does nothing without a real channel ID", async () => {
  const { fetchImpl, calls } = makeFetch(() => Response.json([]));
  assert.equal(await deleteOldMessages(env({ COACH_CHANNEL_ID: "PASTE_CHANNEL_ID" }), NOW, fetchImpl), 0);
  assert.equal(calls.length, 0);
});

test("a Discord error is thrown so the cron logs it", async () => {
  const { fetchImpl } = makeFetch(() => new Response("Missing Permissions", { status: 403 }));
  await assert.rejects(deleteOldMessages(env(), NOW, fetchImpl), /HTTP 403/);
});
