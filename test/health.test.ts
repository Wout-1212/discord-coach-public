import assert from "node:assert/strict";
import { test } from "node:test";
import { runSafely } from "../src/health.ts";
import { makeEnv, makeFetch, makeKV } from "./helpers.ts";

function setup(webhook: () => Response = () => Response.json({})) {
  const { kv, data } = makeKV();
  const env = { ...makeEnv("k"), STATE: kv, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" };
  const { fetchImpl, calls } = makeFetch(webhook);
  const fail = () => Promise.reject(new Error("Intervals HTTP 401: nope"));
  return { env, data, fetchImpl, calls, fail };
}

test("runSafely: warns once after 3 failures in a row, then stays quiet", async () => {
  const { env, fetchImpl, calls, fail } = setup();
  await runSafely(env, "activity nudges", fail, 3, fetchImpl);
  await runSafely(env, "activity nudges", fail, 3, fetchImpl);
  assert.equal(calls.length, 0);

  await runSafely(env, "activity nudges", fail, 3, fetchImpl);
  assert.equal(calls.length, 1);
  const post = JSON.parse(calls[0]!.body!);
  assert.equal(post.username, "System");
  assert.match(post.content, /^⚠️ The activity nudges job failed 3 times in a row: Intervals HTTP 401: nope/);

  await runSafely(env, "activity nudges", fail, 3, fetchImpl);
  assert.equal(calls.length, 1);
});

test("runSafely: a job that isn't retried warns straight away", async () => {
  const { env, fetchImpl, calls, fail } = setup();
  await runSafely(env, "weather check", fail, 1, fetchImpl);
  assert.match(JSON.parse(calls[0]!.body!).content, /^⚠️ The weather check job failed: /);
});

test("runSafely: a success starts the count over, and a later failure can warn again", async () => {
  const { env, data, fetchImpl, calls, fail } = setup();
  await runSafely(env, "cleanup", fail, 2, fetchImpl);
  await runSafely(env, "cleanup", async () => 0, 2, fetchImpl);
  assert.equal(data.has("failing:cleanup"), false);

  await runSafely(env, "cleanup", fail, 2, fetchImpl);
  assert.equal(calls.length, 0, "the earlier failure no longer counts");
  await runSafely(env, "cleanup", fail, 2, fetchImpl);
  assert.equal(calls.length, 1);
  await runSafely(env, "cleanup", async () => 3, 2, fetchImpl);
  await runSafely(env, "cleanup", fail, 1, fetchImpl);
  assert.equal(calls.length, 2);
});

test("runSafely: never throws; a warning that can't be posted is tried again", async () => {
  let up = false;
  const { env, fetchImpl, calls, fail } = setup(() => (up ? Response.json({}) : new Response("down", { status: 503 })));
  await runSafely(env, "watchdog", fail, 1, fetchImpl);
  assert.equal(calls.length, 1);
  up = true;
  await runSafely(env, "watchdog", fail, 1, fetchImpl);
  assert.equal(calls.length, 2);
  await runSafely(env, "watchdog", fail, 1, fetchImpl);
  assert.equal(calls.length, 2, "posted, so quiet now");
});
