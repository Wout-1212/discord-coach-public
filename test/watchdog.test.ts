import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscordMessage } from "../src/types.ts";
import { type PendingRun, checkPendingRuns, warningLine } from "../src/watchdog.ts";
import { makeEnv, makeFetch, makeKV } from "./helpers.ts";

const FIRED = Date.parse("2026-11-03T14:00:00Z");
const run: PendingRun = {
  token: "ack-token",
  channelId: "chan-1",
  message: "> hi\nack",
  firedAt: FIRED,
  sessionUrl: "https://claude.ai/code/s",
};

function setup(channel: DiscordMessage[], editStatus = 200) {
  const { kv, data } = makeKV({ "pending:i1": JSON.stringify(run) });
  const env = { ...makeEnv("00"), STATE: kv, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/42/s" };
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.includes("/channels/chan-1/messages")) return Response.json(channel);
    if (call.method === "PATCH") return new Response("{}", { status: editStatus });
    return Response.json({});
  });
  return { env, data, fetchImpl, calls };
}

const after = (minutes: number) => FIRED + minutes * 60_000;
const coachReply: DiscordMessage = {
  id: "r",
  content: "Your ride looked good.",
  timestamp: new Date(after(2)).toISOString(),
  author: { id: "wh", username: "Coach" },
  webhook_id: "wh",
};
const nudge: DiscordMessage = { ...coachReply, author: { id: "wh", username: "Intervals" } };

test("too early: nothing checked yet", async () => {
  const { env, data, fetchImpl, calls } = setup([]);
  assert.equal(await checkPendingRuns(env, after(5), fetchImpl), 0);
  assert.equal(calls.length, 0);
  assert.ok(data.has("pending:i1"));
});

test("answered: no warning, entry removed", async () => {
  const { env, data, fetchImpl, calls } = setup([coachReply]);
  assert.equal(await checkPendingRuns(env, after(11), fetchImpl), 0);
  assert.ok(!calls.some((c) => c.method === "PATCH"));
  assert.ok(!data.has("pending:i1"));
});

test("no answer (an Intervals nudge doesn't count): warning under the ack", async () => {
  const { env, data, fetchImpl, calls } = setup([nudge]);
  assert.equal(await checkPendingRuns(env, after(11), fetchImpl), 1);
  const edit = calls.find((c) => c.method === "PATCH");
  assert.ok(edit?.url.endsWith("/webhooks/app-1/ack-token/messages/@original"));
  assert.equal(JSON.parse(edit!.body!).content, `${run.message}\n${warningLine(10, run.sessionUrl)}`);
  assert.ok(!data.has("pending:i1"));
});

test("expired interaction token: the warning is posted as its own message", async () => {
  const { env, fetchImpl, calls } = setup([], 401);
  assert.equal(await checkPendingRuns(env, after(16), fetchImpl), 1);
  const post = calls.find((c) => c.url.startsWith("https://discord.com/api/webhooks/42/s"));
  const body = JSON.parse(post!.body!);
  assert.equal(body.username, "System");
  assert.match(body.content, /^⚠️ No answer after 10 min/);
});

test("a weather run (no interaction token) gets its warning as a new message", async () => {
  const { kv, data } = makeKV();
  const env = { ...makeEnv("k"), STATE: kv, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" };
  const weatherRun: PendingRun = {
    channelId: "chan-1",
    message: "🌦️ Weather switch (Sat 07 Nov)",
    firedAt: FIRED,
    sessionUrl: "https://claude.ai/code/s",
  };
  data.set("pending:weather-1", JSON.stringify(weatherRun));
  const { fetchImpl, calls } = makeFetch((call) =>
    call.url.includes("/channels/chan-1/messages") ? Response.json([]) : Response.json({}),
  );
  assert.equal(await checkPendingRuns(env, FIRED + 11 * 60_000, fetchImpl), 1);
  assert.equal(calls.some((c) => c.method === "PATCH"), false, "nothing to edit");
  const posted = calls.filter((c) => c.method === "POST");
  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0]!.body!);
  assert.equal(body.username, "System");
  assert.equal(body.content, `🌦️ Weather switch (Sat 07 Nov)\n${warningLine(10, "https://claude.ai/code/s")}`);
  assert.equal(data.has("pending:weather-1"), false);
});

test("a run with `pin` gets its answer pinned and the previous one unpinned", async () => {
  const { kv, data } = makeKV({ "pinned:weekly-review": JSON.stringify(["old-1"]) });
  const env = { ...makeEnv("k"), STATE: kv, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" };
  data.set(
    "pending:weekly-review-1",
    JSON.stringify({ channelId: "chan-1", message: "📈 Scheduled weekly review", firedAt: FIRED, pin: "weekly-review" }),
  );
  const coach = (id: string, minutes: number): DiscordMessage => ({
    id,
    content: "review",
    timestamp: new Date(FIRED + minutes * 60_000).toISOString(),
    author: { id: "wh", username: "Coach" },
    webhook_id: "wh",
  });
  // Newest first, like Discord: the review was split into two messages.
  const history = [coach("new-2", 3), coach("new-1", 2), coach("before", -5)];
  const { fetchImpl, calls } = makeFetch((call) =>
    call.url.includes("/channels/chan-1/messages?") ? Response.json(history) : new Response(null, { status: 204 }),
  );
  assert.equal(await checkPendingRuns(env, FIRED + 11 * 60_000, fetchImpl), 0);
  const pins = calls.filter((c) => c.url.includes("/messages/pins/")).map((c) => `${c.method} ${c.url.split("/").pop()}`);
  assert.deepEqual(pins, ["PUT new-1", "PUT new-2", "DELETE old-1"]);
  assert.equal(data.get("pinned:weekly-review"), JSON.stringify(["new-1", "new-2"]));
});

test("a run with `pinPrefix` only pins its own answer and the parts right after it", async () => {
  const { kv, data } = makeKV();
  const env = { ...makeEnv("k"), STATE: kv, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" };
  data.set(
    "pending:weekly-review-1",
    JSON.stringify({ channelId: "chan-1", message: "📈 Scheduled weekly review", firedAt: FIRED, pin: "weekly-review", pinPrefix: "📈" }),
  );
  const coach = (id: string, seconds: number, content: string): DiscordMessage => ({
    id,
    content,
    timestamp: new Date(FIRED + seconds * 1000).toISOString(),
    author: { id: "wh", username: "Coach" },
    webhook_id: "wh",
  });
  // Newest first: a ride analysis, then the review in two parts, then another analysis later.
  const history = [
    coach("analysis-2", 400, "🔍 **Ride**"),
    coach("review-2", 181, "next week…"),
    coach("review-1", 180, "📈 **Weekly review · week of 9 Nov**"),
    coach("analysis-1", 60, "🔍 **Run/Walk**"),
  ];
  const { fetchImpl, calls } = makeFetch((call) =>
    call.url.includes("/channels/chan-1/messages?") ? Response.json(history) : new Response(null, { status: 204 }),
  );
  assert.equal(await checkPendingRuns(env, FIRED + 11 * 60_000, fetchImpl), 0);
  const pins = calls.filter((c) => c.url.includes("/messages/pins/")).map((c) => `${c.method} ${c.url.split("/").pop()}`);
  assert.deepEqual(pins, ["PUT review-1", "PUT review-2"]);
});

test("a damaged entry is dropped and the others are still checked", async () => {
  const { env, data, fetchImpl } = setup([coachReply]);
  data.set("pending:broken", "{not json");
  assert.equal(await checkPendingRuns(env, after(11), fetchImpl), 0);
  assert.ok(!data.has("pending:broken"));
  assert.ok(!data.has("pending:i1"), "the good entry was checked too");
});
