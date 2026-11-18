import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntervalsActivity, IntervalsEvent } from "../src/intervals.ts";
import { planActualLines } from "../src/plan-actual.ts";

const TODAY = "2026-11-15"; // Sunday
const planned = (id: number, day: string, type: string, name: string, moving_time: number, extra: Partial<IntervalsEvent> = {}): IntervalsEvent => ({
  id,
  category: "WORKOUT",
  type,
  name,
  start_date_local: `${day}T00:00:00`,
  moving_time,
  ...extra,
});
const done = (id: string, day: string, type: string, name: string, moving_time: number, extra: Partial<IntervalsActivity> = {}): IntervalsActivity => ({
  id,
  type,
  name,
  start_date_local: `${day}T17:00:00`,
  moving_time,
  ...extra,
});

test("planActualLines: done, shorter, swapped, missed, extra and not done yet, in date order", () => {
  const events = [
    planned(1, "2026-11-10", "Run", "Run/Walk — L3", 2100, { paired_activity_id: "a1" }),
    planned(2, "2026-11-12", "Run", "Run/Walk — L3", 2100),
    planned(3, "2026-11-13", "VirtualRide", "Ride — Z2 2h", 7200, { paired_activity_id: "a2" }),
    planned(4, "2026-11-14", "VirtualRide", "Ride — Z2 1h30 (Z2)", 5400),
    planned(5, "2026-11-15", "VirtualRide", "Ride — Sweet Spot", 4500),
    planned(6, "2026-11-01", "Run", "too old", 2100),
  ];
  const activities = [
    done("a3", "2026-11-14", "Ride", "Morning ride", 7500, { trainer: false }),
    done("a2", "2026-11-13", "VirtualRide", "Zwift", 4200, { trainer: true, icu_average_watts: 120 }),
    done("a4", "2026-11-11", "WeightTraining", "Strength A", 1200),
    done("a1", "2026-11-10", "Run", "Run/Walk — L3", 2050),
  ];
  assert.deepEqual(planActualLines(events, activities, TODAY), [
    "Plan vs actual, last 7 days (Worker; start every activity comment from this):",
    "- Tue 10 Nov · Run/Walk — L3 (planned 35 min): done, 34 min (98%)",
    "- Wed 11 Nov · Strength A (20 min): extra, not planned",
    "- Thu 12 Nov · Run/Walk — L3 (planned 35 min): missed",
    "- Fri 13 Nov · Ride — Z2 2h (planned 2h): shorter, 1h10 (58%)",
    "- Sat 14 Nov · Ride — Z2 1h30 (Z2) (planned 1h30): swapped for Morning ride (2h05, load HR-based), not a miss",
    "- Sun 15 Nov · Ride — Sweet Spot (planned 1h15): not done yet",
    // Planned Tue–Sat (today's ride isn't done yet, so it's left out) vs done Tue–Sat.
    "Week so far (Mon 9 Nov–Sun 15 Nov): planned 4h40, done 4h09",
  ]);
});

test("planActualLines: an empty week says so", () => {
  assert.deepEqual(planActualLines([], [], TODAY), ["Plan vs actual, last 7 days: nothing planned or done."]);
});
