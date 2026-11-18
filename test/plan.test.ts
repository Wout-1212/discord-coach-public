import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/index.ts";
import type { IntervalsEvent } from "../src/intervals.ts";
import { formatDuration, formatPlan, planDates, showPlan } from "../src/plan.ts";
import { makeCtx, makeEnv, makeFetch, makeSigner, signedRequest } from "./helpers.ts";

const NOW = new Date("2026-11-03T18:00:00Z"); // Tuesday, 19:00 in Brussels

const ride: IntervalsEvent = {
  id: 1,
  start_date_local: "2026-11-03T00:00:00",
  category: "WORKOUT",
  type: "VirtualRide",
  name: "Ride — Aerobic Foundation 90m (Z2)",
  moving_time: 5400,
  icu_training_load: 65,
  indoor: true,
  paired_activity_id: "i205170359",
};
const strength: IntervalsEvent = {
  id: 2,
  start_date_local: "2026-11-03T00:00:00",
  category: "WORKOUT",
  type: "WeightTraining",
  name: "Strength A",
  moving_time: 1500,
};
const run: IntervalsEvent = {
  id: 3,
  start_date_local: "2026-11-04T00:00:00",
  category: "WORKOUT",
  type: "Run",
  name: "Run/Walk — 45/90 L2",
  moving_time: 1950,
  icu_training_load: 20,
};
const eftp: IntervalsEvent = { id: 4, start_date_local: "2026-11-03T00:00:00", category: "SET_EFTP", name: "eFTP" };

test("planDates: today, tomorrow, a weekday (today included), the week, in Brussels time", () => {
  assert.deepEqual(planDates("today", NOW), ["2026-11-03"]);
  assert.deepEqual(planDates("tomorrow", NOW), ["2026-11-04"]);
  assert.deepEqual(planDates("tue", NOW), ["2026-11-03"]);
  assert.deepEqual(planDates("sat", NOW), ["2026-11-07"]);
  assert.deepEqual(planDates("mon", NOW), ["2026-11-09"]);
  const week = planDates("week", NOW);
  assert.equal(week.length, 7);
  assert.equal(week[0], "2026-11-03");
  assert.equal(week[6], "2026-11-09");
  // 23:30 UTC is already Wednesday in Brussels.
  assert.deepEqual(planDates("today", new Date("2026-11-03T23:30:00Z")), ["2026-11-04"]);
});

test("formatDuration", () => {
  assert.equal(formatDuration(5400), "1h30");
  assert.equal(formatDuration(7200), "2h");
  assert.equal(formatDuration(3600), "1h");
  assert.equal(formatDuration(1950), "33 min");
});

test("formatPlan: one day, with done mark, indoor and load; other dates and internal events left out", () => {
  const out = formatPlan([ride, strength, run, eftp], ["2026-11-03"], NOW);
  assert.match(out, /^📅 \*\*Today · Tue 03 Nov\*\*\n/);
  assert.match(out, /🚴 Ride — Aerobic Foundation 90m \(Z2\) · 1h30 · 65 load · indoor ✅\n/);
  assert.match(out, /🏋️ Strength A · 25 min\n/);
  assert.ok(!out.includes("Run/Walk"), "tomorrow's run not shown");
  assert.ok(!out.includes("eFTP"));
  assert.ok(!out.includes("Total"), "no total for a single day");
});

test("formatPlan: empty day, and the week with rest days and a total", () => {
  assert.match(formatPlan([], ["2026-11-04"], NOW), /\*\*Tomorrow · Wed 04 Nov\*\*\nNothing planned: rest day\./);
  const week = formatPlan([ride, strength, run], planDates("week", NOW), NOW);
  assert.match(week, /\*\*Tomorrow · Wed 04 Nov\*\*\n🏃 Run\/Walk/);
  assert.match(week, /\*\*Thu 05 Nov\*\*\nRest/);
  assert.match(week, /Total: 2h28 · 85 load/);
});

test("showPlan asks Intervals for the dates (+1 day) and explains a rejected key", async () => {
  const { fetchImpl, calls } = makeFetch(() => Response.json([ride]));
  const out = await showPlan(makeEnv("00"), "today", NOW, fetchImpl);
  assert.match(out, /Aerobic Foundation/);
  assert.ok(calls[0]!.url.endsWith("/athlete/i123/events?oldest=2026-11-03&newest=2026-11-04"));

  const denied = makeFetch(() => new Response("nope", { status: 401 }));
  assert.match(await showPlan(makeEnv("00"), "week", NOW, denied.fetchImpl), /rejected the API key/);
});

test("/plan answers with a deferred message, then edits in the plan", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) =>
    call.url.includes("intervals.icu") ? Response.json([]) : new Response("{}"),
  );
  const res = await handleRequest(
    await signedRequest(
      {
        id: "i-plan",
        application_id: "app-1",
        type: 2,
        token: "plan-token",
        member: { user: { id: "owner-1", username: "wout" } },
        data: { name: "plan", options: [{ name: "day", type: 3, value: "tomorrow" }] },
      },
      sign,
    ),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  assert.deepEqual(await res.json(), { type: 5 });
  await settle();
  const edit = calls.find((c) => c.method === "PATCH");
  assert.ok(edit?.url.endsWith("/webhooks/app-1/plan-token/messages/@original"));
  assert.match(JSON.parse(edit!.body!).content, /^📅 \*\*Tomorrow/);
});
