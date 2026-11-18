import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntervalsActivity } from "../src/intervals.ts";
import { TASKS, dueTasks, runScheduledTasks, unanalysedActivities } from "../src/scheduled.ts";
import { makeEnv, makeFetch, makeKV } from "./helpers.ts";

// Brussels is UTC+1 in November.
const at = (utc: string) => new Date(utc);
const kinds = (now: Date) => dueTasks(now).map((t) => t.kind);

test("dueTasks: each task at its Brussels time and weekday, once per 5-minute tick", () => {
  assert.deepEqual(kinds(at("2026-11-05T09:00:00Z")), ["morning brief"]); // Thu 10:00
  assert.deepEqual(kinds(at("2026-11-05T09:04:59Z")), ["morning brief"]);
  assert.deepEqual(kinds(at("2026-11-05T09:05:00Z")), []);
  assert.deepEqual(kinds(at("2026-11-05T19:35:00Z")), ["activity check"]); // 20:35
  assert.deepEqual(kinds(at("2026-11-05T18:45:00Z")), ["weekend outlook"]); // Thu 19:45
  assert.deepEqual(kinds(at("2026-11-06T18:45:00Z")), [], "Friday: no outlook");
  assert.deepEqual(kinds(at("2026-11-08T18:40:00Z")), ["weekly review"]); // Sun 19:40
  assert.deepEqual(kinds(at("2026-06-07T17:40:00Z")), ["weekly review"], "summer time");
});

test("every task has instructions in cloud/routines/", async () => {
  const { existsSync } = await import("node:fs");
  for (const t of TASKS) assert.ok(existsSync(`cloud/routines/${t.file}`), t.file);
});

const activity = (start: string): IntervalsActivity => ({ id: start, start_date_local: start });

test("unanalysedActivities: today's and yesterday's activities without an analysis, oldest first", async () => {
  const now = at("2026-11-05T19:35:00Z");
  // Yesterday 19:45: it synced after yesterday's check, so the old 20:35 cutoff missed it.
  const evening = activity("2026-11-04T19:45:00");
  const done = activity("2026-11-05T07:00:00");
  const today = activity("2026-11-05T17:00:00");
  const { kv, data } = makeKV({ [`analysed:${done.id}`]: "1" });
  const env = { ...makeEnv("k"), STATE: kv };
  const prepared = await unanalysedActivities(env, now, makeFetch(() => Response.json([today, done, evening])).fetchImpl);
  assert.equal(
    prepared?.request,
    "Activities to cover (no automatic analysis yet):\n" +
      "- Wed 04 Nov, 19:45 · Activity (Intervals id 2026-11-04T19:45:00)\n" +
      "- Thu 05 Nov, 17:00 · Activity (Intervals id 2026-11-05T17:00:00)",
  );
  assert.equal(data.has(`analysed:${today.id}`), false, "only marked once the run has started");
  await prepared!.started!();
  assert.ok(data.has(`analysed:${today.id}`) && data.has(`analysed:${evening.id}`));

  assert.equal(await unanalysedActivities(env, now, makeFetch(() => Response.json([today, done])).fetchImpl), null);
});

function setup(opts: { activities?: IntervalsActivity[]; fire?: boolean } = {}) {
  const { kv, data } = makeKV();
  const env = { ...makeEnv("k"), STATE: kv, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x", COACH_CHANNEL_ID: "chan-1" };
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.includes("intervals.icu")) return Response.json(opts.activities ?? []);
    if (call.url.includes("open-meteo")) return new Response("down", { status: 503 });
    if (call.url.includes("/channels/chan-1/messages")) return Response.json([]);
    if (call.url.includes("anthropic.com")) {
      return opts.fire === false
        ? Response.json({ error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 })
        : Response.json({ claude_code_session_url: "https://claude.ai/code/s" });
    }
    return Response.json({});
  });
  return { env, data, fetchImpl, calls };
}

test("runScheduledTasks: starts the coach with the task's file, tracked by the watchdog, once a day", async () => {
  const now = at("2026-11-08T18:40:00Z"); // Sunday 19:40: weekly review
  const { env, data, fetchImpl, calls } = setup();
  assert.equal(await runScheduledTasks(env, now, fetchImpl), 1);

  const text = JSON.parse(calls.find((c) => c.url.includes("anthropic.com"))!.body!).text as string;
  assert.match(text, /From: the Worker's automated weekly review/);
  assert.match(text, /=== Automated weekly review \(this is the request\) ===\nDo the scheduled weekly review: read `cloud\/routines\/weekly-review\.md`/);
  assert.match(text, /=== Ride weather, next 7 days/);

  assert.deepEqual(JSON.parse(data.get(`pending:weekly-review-${now.getTime()}`)!), {
    channelId: "chan-1",
    message: "📈 Scheduled weekly review",
    firedAt: now.getTime(),
    sessionUrl: "https://claude.ai/code/s",
    pin: "weekly-review",
    pinPrefix: "📈",
  });
  assert.equal(calls.some((c) => c.url.includes("webhooks")), false, "the coach posts the answer itself");

  // The next cron tick in the same 5 minutes (or a duplicate trigger) doesn't start it again.
  const again = makeFetch(() => Response.json({}));
  assert.equal(await runScheduledTasks(env, new Date(now.getTime() + 60_000), again.fetchImpl), 0);
  assert.equal(again.calls.length, 0);
});

test("runScheduledTasks: the activity check only runs for activities without an analysis", async () => {
  const now = at("2026-11-05T19:35:00Z");
  const none = setup();
  assert.equal(await runScheduledTasks(none.env, now, none.fetchImpl), 0);
  assert.equal(none.calls.some((c) => c.url.includes("anthropic")), false);

  const analysed = setup({ activities: [activity("2026-11-05T17:00:00")] });
  analysed.data.set("analysed:2026-11-05T17:00:00", "1");
  assert.equal(await runScheduledTasks(analysed.env, now, analysed.fetchImpl), 0, "already analysed after feedback");

  const some = setup({ activities: [activity("2026-11-05T17:00:00")] });
  assert.equal(await runScheduledTasks(some.env, now, some.fetchImpl), 1);
  const text = JSON.parse(some.calls.find((c) => c.url.includes("anthropic.com"))!.body!).text as string;
  assert.match(text, /follow it\.\n\nActivities to cover \(no automatic analysis yet\):\n- Thu 05 Nov, 17:00/);
  assert.ok(some.data.has("analysed:2026-11-05T17:00:00"), "covered once");
  assert.equal([...some.data.keys()].some((k) => k.startsWith("pending:")), false, "it may stay silent: no watchdog");
});

test("runScheduledTasks: an activity check that can't start leaves its activities for the next one", async () => {
  const { env, data, fetchImpl } = setup({ activities: [activity("2026-11-05T17:00:00")], fire: false });
  assert.equal(await runScheduledTasks(env, at("2026-11-05T19:35:00Z"), fetchImpl), 0);
  assert.equal(data.has("analysed:2026-11-05T17:00:00"), false);
});

test("runScheduledTasks: a run that can't start gets a System notice", async () => {
  const { env, fetchImpl, calls } = setup({ fire: false });
  assert.equal(await runScheduledTasks(env, at("2026-11-05T09:00:00Z"), fetchImpl), 0);
  const notice = JSON.parse(calls.find((c) => c.url.includes("webhooks"))!.body!);
  assert.equal(notice.username, "System");
  assert.match(notice.content, /^⚠️ Couldn't start the morning brief \(rate_limit_error: slow down\)/);
});
