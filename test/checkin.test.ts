import assert from "node:assert/strict";
import { test } from "node:test";
import { postMorningCheck } from "../src/checkin.ts";
import { handleRequest } from "../src/index.ts";
import { postPlanProblems } from "../src/plan-alerts.ts";
import { brusselsSlot } from "../src/scheduled.ts";
import { makeCtx, makeEnv, makeFetch, makeKV, makeSigner, signedRequest } from "./helpers.ts";

const WEBHOOK = "https://discord.com/api/webhooks/42/secret";
const MORNING = new Date("2026-11-17T07:00:00Z"); // Tue 08:00 in Brussels
const run = (day: string) => ({ id: `i${day.replaceAll("-", "")}`, type: "Run", name: "Run/Walk — L3", start_date_local: `${day}T18:00:00` });

function setup(activities: unknown[], messages: Record<string, unknown[]> = {}, events: unknown[] = []) {
  const { kv, data } = makeKV();
  const env = { ...makeEnv("00"), STATE: kv, DISCORD_WEBHOOK_URL: WEBHOOK };
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.endsWith("/messages")) return Response.json(messages[call.url.split("/").at(-2)!] ?? []);
    if (call.url.includes("/events")) return Response.json(events);
    if (call.url.includes("/wellness")) return Response.json([]);
    if (call.url.endsWith("/intervals")) return Response.json({ icu_intervals: [] });
    if (call.url.includes("intervals.icu")) return Response.json(activities);
    return Response.json({ id: "msg" });
  });
  return { env, data, fetchImpl, calls };
}
const posts = (calls: { url: string; body?: string }[]) =>
  calls.filter((c) => c.url.startsWith(WEBHOOK)).map((c) => JSON.parse(c.body!) as { username: string; content: string; components: { components: { custom_id: string; label: string }[] }[] });

test("the morning check is due at 08:00 Brussels", () => {
  assert.equal(brusselsSlot(MORNING), "08:00");
  assert.equal(brusselsSlot(new Date("2026-11-17T07:04:59Z")), "08:00");
});

test("after a run yesterday: feel and legs rows; posted once a day", async () => {
  const { env, data, fetchImpl, calls } = setup([run("2026-11-16")]);
  assert.equal(await postMorningCheck(env, MORNING, fetchImpl), 1);
  const [post] = posts(calls);
  assert.equal(post!.username, "Check-in");
  assert.equal(
    post!.content,
    "☀️ **Morning check · Tue 17 Nov**\nHow do you feel this morning?\nLegs this morning, after the Mon 16 Nov run?\n-# One tap each. The 10:00 brief reads it; skipping is fine.",
  );
  assert.deepEqual(post!.components[0]!.components.map((b) => b.label), ["Very fresh", "Fresh", "Tired", "Very tired"]);
  assert.equal(post!.components[0]!.components[2]!.custom_id, "checkin:feel:2026-11-17:3");
  assert.deepEqual(post!.components[1]!.components.map((b) => b.custom_id), [
    "checkin:legs:i20261116:none",
    "checkin:legs:i20261116:better",
    "checkin:legs:i20261116:same",
    "checkin:legs:i20261116:worse",
  ]);
  assert.ok(data.has("checkin:2026-11-17"));
  assert.equal(await postMorningCheck(env, MORNING, fetchImpl), 0, "not twice");
});

test("no run yesterday: only the feel row, unless a pain report is still open", async () => {
  const quiet = setup([run("2026-11-12")]);
  await postMorningCheck(quiet.env, MORNING, quiet.fetchImpl);
  assert.equal(posts(quiet.calls)[0]!.components.length, 1);

  const sore = setup([run("2026-11-12")], { i20261112: [{ content: "Pain: calf 2/10, during" }] });
  await postMorningCheck(sore.env, MORNING, sore.fetchImpl);
  assert.equal(posts(sore.calls)[0]!.components.length, 2);
  assert.match(posts(sore.calls)[0]!.content, /after the Thu 12 Nov run\?/);
});

function tap(customId: string, userId = "owner-1") {
  return {
    id: "tap-1",
    application_id: "app-1",
    type: 3,
    token: "tap-token",
    channel_id: "chan-1",
    member: { user: { id: userId, username: "wout" } },
    data: { custom_id: customId, component_type: 2 },
    message: {
      id: "check-1",
      content: "☀️ **Morning check · Tue 17 Nov**\nHow do you feel this morning?\nLegs this morning, after the Mon 16 Nov run?\n-# One tap each. The 10:00 brief reads it; skipping is fine.",
      timestamp: MORNING.toISOString(),
      author: { id: "wh", username: "Check-in" },
      webhook_id: "wh",
      components: [
        { type: 1, components: [{ type: 2, custom_id: "checkin:feel:2026-11-17:3" }] },
        { type: 1, components: [{ type: 2, custom_id: "checkin:legs:i20261116:same" }] },
      ],
    },
  };
}

async function send(body: unknown) {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch(() => Response.json({}));
  const res = await handleRequest(await signedRequest(body, sign), makeEnv(publicKeyHex), ctx, fetchImpl);
  await settle();
  return { res, calls };
}

test("a feel tap sets today's wellness fatigue and replaces its row", async () => {
  const { res, calls } = await send(tap("checkin:feel:2026-11-17:3"));
  assert.deepEqual(await res.json(), { type: 6 });
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put?.url.endsWith("/athlete/i123/wellness/2026-11-17"));
  assert.deepEqual(JSON.parse(put!.body!), { id: "2026-11-17", fatigue: 3 });
  const edit = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
  assert.equal(
    edit.content,
    "☀️ **Morning check · Tue 17 Nov**\nLegs this morning, after the Mon 16 Nov run?\n✅ Feel saved: **Tired**\n-# One tap each. The 10:00 brief reads it; skipping is fine.",
  );
  assert.equal(edit.components.length, 1, "the legs row stays");
});

test("a legs tap adds a next-morning message on the run; someone else's tap is refused", async () => {
  const { calls } = await send(tap("checkin:legs:i20261116:worse"));
  const post = calls.find((c) => c.url.endsWith("/activity/i20261116/messages"));
  assert.match(JSON.parse(post!.body!).content, /^Next morning \(\w{3} \d+ \w{3}\): worse$/);
  assert.match(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).content, /✅ Legs saved: \*\*worse\*\*\. Worse than yesterday: the pain rule applies/);

  const other = await send(tap("checkin:feel:2026-11-17:1", "intruder"));
  assert.match(((await other.res.json()) as { data: { content: string } }).data.content, /private/);
  assert.equal(other.calls.length, 0);
});

test("the 19:05 plan check posts each new problem once", async () => {
  const events = [
    { id: 1, category: "WORKOUT", type: "Run", name: "Run/Walk — L3", start_date_local: "2026-11-18T00:00:00", moving_time: 2100 },
    { id: 2, category: "WORKOUT", type: "Run", name: "Run/Walk — L3", start_date_local: "2026-11-19T00:00:00", moving_time: 2100 },
  ];
  const { env, fetchImpl, calls } = setup([run("2026-11-16")], {}, events);
  const evening = new Date("2026-11-17T18:05:00Z");
  // Monday's done run counts too: Wed + Thu make it 3 runs that week.
  assert.equal(await postPlanProblems(env, evening, fetchImpl), 2);
  const [post] = posts(calls);
  assert.equal(post!.username, "System");
  assert.match(post!.content, /^⚠️ \*\*Plan check\*\*.*\n- Thu 19 Nov · Run\/Walk — L3: a run the day after another run/);
  assert.match(post!.content, /\n- week of Mon 16 Nov: 3 runs \(max 2/);
  assert.equal(await postPlanProblems(env, evening, fetchImpl), 0, "not again");
});
