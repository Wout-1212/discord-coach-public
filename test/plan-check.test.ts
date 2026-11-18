import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntervalsActivity, IntervalsEvent } from "../src/intervals.ts";
import { inHomeWeek, planCheck, planCheckLines } from "../src/plan-check.ts";

const TODAY = "2026-11-16"; // Monday
let nextId = 1;
const event = (day: string, type: string, name: string, extra: Partial<IntervalsEvent> = {}): IntervalsEvent => ({
  id: nextId++,
  category: "WORKOUT",
  type,
  name,
  start_date_local: `${day}T00:00:00`,
  moving_time: 2100,
  ...extra,
});
const runEvent = (day: string, level = 3, extra: Partial<IntervalsEvent> = {}) => event(day, "Run", `Run/Walk — L${level}`, extra);
const check = (events: IntervalsEvent[], activities: IntervalsActivity[] = [], extra = {}) =>
  planCheck({ events, activities, today: TODAY, allowedLevel: 3, longestTime: 2400, ...extra });

test("a normal week meets every rule", () => {
  const week = [
    runEvent("2026-11-16"),
    event("2026-11-17", "WeightTraining", "Strength A"),
    runEvent("2026-11-18"),
    event("2026-11-19", "WeightTraining", "Strength B"),
    event("2026-11-20", "VirtualRide", "Ride — Sweet Spot 3x10", { indoor: true, moving_time: 4500 }),
    event("2026-11-21", "Ride", "Ride — Endurance 2h30 (Z2)", { moving_time: 9000 }),
  ];
  assert.deepEqual(check(week), []);
  assert.deepEqual(planCheckLines([]), ["Plan check (next 14 days, Worker rules): ✅ all rules met"]);
});

test("runs: Mon–Thu only, never on consecutive days, max 2 a week", () => {
  assert.match(check([runEvent("2026-11-21")])[0]!, /^Sat 21 Nov · Run\/Walk — L3: a run outside Mon–Thu/);
  assert.match(check([runEvent("2026-11-17"), runEvent("2026-11-18")]).join("\n"), /Wed 18 Nov · .*: a run the day after another run/);
  const done: IntervalsActivity = { id: "a1", type: "Run", name: "Run/Walk — L3", start_date_local: "2026-11-15T18:00:00" };
  assert.match(check([runEvent("2026-11-16")], [done]).join("\n"), /Mon 16 Nov .*the day after another run/, "a done run counts");
  const three = check([runEvent("2026-11-16"), runEvent("2026-11-18"), { ...runEvent("2026-11-20"), start_date_local: "2026-11-20T00:00:00" }]);
  assert.ok(three.some((p) => /^week of Mon 16 Nov: 3 runs \(max 2/.test(p)));
});

test("runs: the +10% line and the ladder gate's level", () => {
  assert.match(check([runEvent("2026-11-17", 3, { moving_time: 3000 })])[0]!, /\+25% vs the longest run of the last 30 days/);
  assert.match(check([runEvent("2026-11-17", 5)])[0]!, /L5, but the ladder gate allows at most L3$/);
  assert.deepEqual(check([runEvent("2026-11-17", 3), runEvent("2026-11-19", 4)]), [], "one level up after a clean next run");
  assert.match(check([runEvent("2026-11-17", 3), runEvent("2026-11-19", 5)])[0]!, /L5, but the ladder gate allows at most L4/);
});

test("rides: Fri–Sun unless a Home week, indoor max 2 h, one quality ride, no hard days back to back", () => {
  const tuesday = event("2026-11-17", "VirtualRide", "Ride — Z2 1h30", { indoor: true, moving_time: 5400 });
  assert.match(check([tuesday])[0]!, /a ride on a school day without a "Home week" note/);
  const home: IntervalsEvent = { id: 99, category: "NOTE", name: "Home week", start_date_local: "2026-11-16T00:00:00", end_date_local: "2026-11-23T00:00:00" };
  assert.deepEqual(check([tuesday, home]), []);
  assert.equal(inHomeWeek("2026-11-23", [home]), false, "the end date is exclusive");

  assert.match(check([event("2026-11-20", "VirtualRide", "Ride — Z2 2h30", { indoor: true, moving_time: 9000 })])[0]!, /indoor ride over 2 h/);
  const hard = check([
    event("2026-11-21", "VirtualRide", "Ride — Sweet Spot", { indoor: true }),
    event("2026-11-22", "VirtualRide", "Ride — Threshold", { indoor: true }),
  ]);
  assert.ok(hard.some((p) => /Sun 22 Nov · Ride — Threshold: a hard ride the day after another hard ride/.test(p)));
  assert.ok(hard.some((p) => /^week of Mon 16 Nov: 2 quality rides \(max 1 a week\)/.test(p)));
});

test("strength: no Strength A on a run day", () => {
  assert.match(check([runEvent("2026-11-17"), event("2026-11-17", "WeightTraining", "Strength A")])[0]!, /Strength A on a run day/);
  assert.deepEqual(check([runEvent("2026-11-17"), event("2026-11-17", "WeightTraining", "Strength B")]), []);
});

test("done sessions and sessions beyond 14 days aren't checked as planned", () => {
  assert.deepEqual(check([runEvent("2026-11-21", 3, { paired_activity_id: "a9" })]), [], "already done");
  assert.deepEqual(check([runEvent("2026-12-05")]), [], "beyond 14 days");
});
