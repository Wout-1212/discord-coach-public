import assert from "node:assert/strict";
import { test } from "node:test";
import {
  flagLines,
  freshnessLines,
  morningCheckLine,
  noteLines,
  historySection,
  isComparableRide,
  painLines,
  plannedRunSeconds,
  rideLines,
  runLines,
  runSegments,
  wellnessLines,
} from "../src/history.ts";
import type { ActivityInterval, IntervalsActivity, IntervalsEvent, IntervalsWellness } from "../src/intervals.ts";
import { descriptionNotes, messageNotes } from "../src/notes.ts";
import { makeEnv, makeFetch } from "./helpers.ts";

// Shapes and numbers are Wout's real data from early November 2026.
const TODAY = "2026-11-07";
const NOW = new Date("2026-11-07T20:00:00Z");

const walk = (seconds: number, cadence = 56): ActivityInterval => ({
  moving_time: seconds,
  average_cadence: cadence,
  average_heartrate: 134,
});
const run = (cadence = 81, heartRate = 142): ActivityInterval => ({
  moving_time: 45,
  average_cadence: cadence,
  average_heartrate: heartRate,
});

/** 4 Nov: 5 min walk, 10×45 s / 90 s, 5 min walk, 9 s left over. Every segment is labelled WORK. */
const L2_RUN: ActivityInterval[] = [
  walk(301, 58.9),
  ...Array.from({ length: 10 }, (_, i) => [run(i === 8 ? 72.8 : 81), walk(90)]).flat(),
  walk(300, 53.5),
  { moving_time: 9, average_cadence: 20.4, average_heartrate: 108 },
];

const runAt = (day: string, distance: number, moving_time: number, extra: Partial<IntervalsActivity> = {}): IntervalsActivity => ({
  id: `run-${day}`,
  type: "Run",
  start_date_local: `${day}T12:00:00`,
  distance,
  moving_time,
  average_heartrate: 132,
  ...extra,
});

// Newest first, as listRecentActivities returns them. 7 Oct is 31 days back: outside the window.
const RUNS = [
  runAt("2026-11-04", 3661.47, 1945, { feel: 4, icu_rpe: 3 }),
  runAt("2026-11-02", 4497.57, 2384, { feel: 4, icu_rpe: 3 }),
  runAt("2026-10-28", 3823.19, 2099, { feel: 2, icu_rpe: 2 }),
  runAt("2026-10-26", 4002.15, 2160),
  runAt("2026-10-21", 3872.14, 2046),
  runAt("2026-10-20", 3888.64, 2028),
  runAt("2026-10-14", 4185.48, 2046),
  runAt("2026-10-12", 4118.03, 2053),
  runAt("2026-10-07", 9000, 4000),
];

const plannedRun = (moving_time: number, distance = 0): IntervalsEvent => ({
  id: 1,
  category: "WORKOUT",
  type: "Run",
  start_date_local: "2026-11-09T12:00:00",
  moving_time,
  distance,
  workout_doc: {
    steps: [
      { text: "Walk", duration: 300 },
      { reps: 10, text: "10x", steps: [{ text: "Run", duration: 45 }, { text: "Walk", duration: 90 }] },
      { text: "Walk", duration: 300 },
    ],
  },
});

test("runSegments: tells run from walk by cadence, because Intervals labels both WORK", () => {
  assert.deepEqual(runSegments(L2_RUN), {
    count: 10,
    totalSeconds: 450,
    longestSeconds: 45,
    sameLength: true,
    heartRate: 142,
  });
});

test("runSegments: a continuous run is one segment", () => {
  const continuous = runSegments([walk(300), { moving_time: 1500, average_cadence: 80, average_heartrate: 150 }, walk(300)]);
  assert.equal(continuous?.count, 1);
  assert.equal(continuous?.totalSeconds, 1500);
});

test("runSegments: says nothing rather than guess", () => {
  assert.equal(runSegments([]), undefined);
  assert.equal(runSegments([walk(1800)]), undefined, "no running at all");
  assert.equal(runSegments([{ moving_time: 1900, average_cadence: 66 }]), undefined, "too close to call");
  assert.equal(runSegments([{ moving_time: 1900 }]), undefined, "no cadence");
});

test("plannedRunSeconds: adds up the run steps, repeats included", () => {
  assert.equal(plannedRunSeconds(plannedRun(1950).workout_doc?.steps), 450);
  assert.equal(plannedRunSeconds([{ text: "Warmup", duration: 600 }]), undefined);
  assert.equal(plannedRunSeconds(undefined), undefined);
});

test("runLines: longest session of the last 30 days, its +10% line and the last 3 runs", () => {
  const segments = new Map([[RUNS[0]!.id, runSegments(L2_RUN)]]);
  const lines = runLines(RUNS, segments, [plannedRun(1950)], TODAY);
  assert.equal(
    lines[0],
    "Runs, last 30 days: 8 sessions · longest 4.50 km (2 Nov) · longest 39:44 (2 Nov) · +10% line 4.95 km / 43:42 · last run 3 days ago",
  );
  assert.equal(lines[1], "Last 3 runs:");
  assert.equal(lines[2], "- 4 Nov: 10×45 s, 7:30 running, run HR 142 · 3.66 km, 32:25 · feel Poor, RPE 3");
  assert.equal(lines[3], "- 2 Nov: run and walk segments unclear · 4.50 km, 39:44 · feel Poor, RPE 3");
  assert.equal(lines[4], "- 28 Oct: run and walk segments unclear · 3.82 km, 34:59 · feel Good, RPE 2");
  assert.equal(lines[5], "Next planned: 9 Nov 32:30 (7:30 running) · under the line");
});

test("runLines: planned runs have distance 0, so duration decides the spike check", () => {
  const over = runLines(RUNS, new Map(), [plannedRun(2700)], TODAY).at(-1);
  assert.equal(over, "Next planned: 9 Nov 45:00 (7:30 running) · ⚠️ over the line (+13% vs the longest)");
  const byDistance = runLines(RUNS, new Map(), [plannedRun(1950, 5000)], TODAY).at(-1);
  assert.match(byDistance!, /over the line \(\+11% vs the longest\)/);
});

test("runLines: a finished planned run isn't next, and other sports aren't runs", () => {
  const done = { ...plannedRun(1950), paired_activity_id: "i1" };
  const ride = { ...plannedRun(1950), type: "Ride" };
  const lines = runLines(RUNS, new Map(), [done, ride], TODAY);
  assert.ok(!lines.some((l) => l.startsWith("Next planned")));
});

test("runLines: no recent runs, and no calendar", () => {
  const lines = runLines([], new Map(), undefined, TODAY);
  assert.deepEqual(lines, [
    "Runs, last 30 days: none, so there's no longest session to compare with.",
    "Next planned: calendar unavailable",
  ]);
  const restart = runLines([], new Map(), [plannedRun(1950)], TODAY).at(-1);
  assert.match(restart!, /no runs to compare with/);
});

const zwift = (name: string, extra: Partial<IntervalsActivity> = {}): IntervalsActivity => ({
  id: name,
  name,
  type: "VirtualRide",
  start_date_local: "2026-11-07T12:20:10",
  moving_time: 5412,
  trainer: true,
  average_heartrate: 142,
  icu_average_watts: 116,
  decoupling: -0.97,
  icu_efficiency_factor: 0.845,
  feel: 2,
  ...extra,
});

test("isComparableRide: steady indoor rides with power and HR only", () => {
  assert.equal(isComparableRide(zwift("Ride — Aerobic Foundation 1h30 (Z2) (optional)")), true);
  assert.equal(isComparableRide(zwift("Z2 Endurance", { moving_time: 7433 })), true);
  assert.equal(
    isComparableRide(zwift("Ride — Sweet Spot 3×10 (75m) — quality", { moving_time: 4530 })),
    false,
    "5 Nov: as intense on average as a Z2 ride, but not steady",
  );
  assert.equal(isComparableRide(zwift("Ride Controlled Tempo")), false);
  assert.equal(isComparableRide(zwift("Short Zwift Race", { moving_time: 1232 })), false);
  assert.equal(isComparableRide(zwift("Aerobic Foundation (Z2)", { moving_time: 2728 })), false, "too short");
  assert.equal(isComparableRide(zwift("Aerobic Foundation (Z2)", { average_heartrate: 0 })), false, "30 Oct: no HR");
  assert.equal(isComparableRide(zwift("Aerobic Foundation (Z2)", { decoupling: null })), false);
  assert.equal(isComparableRide(zwift("Fietsen", { type: "Ride", trainer: false })), false, "outdoor");
});

test("rideLines: the numbers per ride, and outdoor rides kept apart", () => {
  const outdoor: IntervalsActivity = {
    id: "o",
    name: "Fietsen",
    type: "Ride",
    start_date_local: "2026-10-18T12:09:26",
    moving_time: 9617,
    average_heartrate: 148,
  };
  const lines = rideLines([zwift("Ride — Aerobic Foundation (Z2)"), outdoor]);
  assert.deepEqual(lines, [
    "Steady indoor Z2 rides, last 90 days: 1 comparable:",
    "- 7 Nov: 90:12 · 116 W · HR 142 · EF 0.84 · decoupling -1.0% · feel Good",
    "Outdoor rides: 1 in 90 days, latest 18 Oct, avg HR 148. Not comparable with indoor rides.",
  ]);
});

test("rideLines: shows the latest rides but counts them all", () => {
  const rides = Array.from({ length: 12 }, () => zwift("Z2 Endurance"));
  const lines = rideLines(rides);
  assert.equal(lines[0], "Steady indoor Z2 rides, last 90 days: 12 comparable, latest 8:");
  assert.equal(lines.length, 9);
  assert.deepEqual(rideLines([]), ["Steady indoor Z2 rides, last 90 days: none comparable."]);
});

const OLDEST = "2026-10-10";
function wellness(count: number, skip: string[] = []): IntervalsWellness[] {
  return Array.from({ length: count }, (_, i) => {
    const id = new Date(Date.parse(`${OLDEST}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    return { id, hrv: skip.includes(id) ? null : 70 + (i % 2) * 10, restingHR: 48 };
  });
}

test("wellnessLines: a usual range, a missing day stays missing, and no verdict", () => {
  const days = wellness(28, ["2026-10-25"]);
  const [hrv, restingHR] = wellnessLines(days, OLDEST);
  assert.equal(hrv, "HRV 80 on 6 Nov · usual 70–80 · 26 of 27 earlier days recorded");
  assert.equal(restingHR, "Resting HR 48 on 6 Nov · usual 48–48 · 27 of 27 earlier days recorded");
});

test("wellnessLines: says when a reading is outside the range", () => {
  const days = [...wellness(27), { id: "2026-11-06", hrv: 50, restingHR: 48 }];
  assert.match(wellnessLines(days, OLDEST)[0]!, /^HRV 50 on 6 Nov · usual 70–80 · outside it/);
});

test("wellnessLines: too few days, no data and no connection", () => {
  assert.match(wellnessLines(wellness(10), OLDEST)[0]!, /only 9 of 9 earlier days recorded, too few for a usual range/);
  assert.deepEqual(wellnessLines([], OLDEST), ["HRV: no data", "Resting HR: no data"]);
  assert.deepEqual(wellnessLines(undefined, OLDEST), ["Wellness: unavailable"]);
});

test("flagLines: a ride or run without HR; strength never has it", () => {
  const noHeartRate = zwift("Aerobic Foundation 75m (Z2)", {
    start_date_local: "2026-10-30T16:38:02",
    moving_time: 2728,
    average_heartrate: 0,
  });
  const strength: IntervalsActivity = {
    id: "s",
    name: "Strength B",
    type: "WeightTraining",
    start_date_local: "2026-11-06T00:00:00",
    moving_time: 1500,
  };
  assert.deepEqual(flagLines([strength, noHeartRate, RUNS[0]!], TODAY), [
    "Data flags:",
    "- 30 Oct ride: no heart rate, left out of comparisons",
  ]);
  assert.deepEqual(flagLines([strength], TODAY), []);
});

test("painLines: recent reports only, from messages or older descriptions; none logged doesn't mean pain-free", () => {
  const legacy = runAt("2026-11-04", 3661, 1945, { description: "Zwift\n\nFeedback: fine\n\nPain: calf 3/10, during, same" });
  const recent = runAt("2026-11-06", 3700, 1950);
  const old = runAt("2026-10-20", 3888, 2028, { description: "Pain: knee 2/10" });
  const notes = new Map([
    [legacy.id, descriptionNotes(legacy.description)],
    [recent.id, messageNotes([{ content: "Pain: knee 2/10, right after" }])],
  ]);
  assert.deepEqual(painLines([recent, legacy, old], notes, TODAY), [
    "Pain reports, last 14 days:",
    "- 6 Nov: knee 2/10, right after",
    "- 4 Nov: calf 3/10, during, same",
  ]);
  assert.match(painLines([old], new Map(), TODAY)[0]!, /none logged \(that means unknown, not pain-free\)/);
});

function intervalsApi(
  overrides: { wellness?: Response; events?: Response; intervals?: Response; messages?: (url: string) => Response | undefined } = {},
) {
  return makeFetch((call) => {
    if (call.url.includes("/wellness")) return overrides.wellness ?? Response.json(wellness(28));
    if (call.url.includes("/events")) return overrides.events ?? Response.json([plannedRun(1950)]);
    if (call.url.endsWith("/intervals")) return overrides.intervals ?? Response.json({ icu_intervals: L2_RUN });
    if (call.url.endsWith("/messages")) return overrides.messages?.(call.url) ?? Response.json([]);
    return Response.json(RUNS);
  });
}

test("historySection: reads the list once, segments for the last 3 runs, messages for the last 14 days", async () => {
  const { fetchImpl, calls } = intervalsApi();
  const text = await historySection(makeEnv("k"), NOW, fetchImpl);

  const list = calls.find((c) => c.url.includes("/activities?"));
  assert.match(list!.url, /oldest=2026-08-09&newest=2026-11-08&fields=id,name,type,/);
  assert.equal(calls.filter((c) => c.url.endsWith("/intervals")).length, 3);
  assert.equal(calls.filter((c) => c.url.endsWith("/messages")).length, 4, "the 4 runs since 24 Oct");
  assert.match(calls.find((c) => c.url.includes("/events"))!.url, /oldest=2026-10-31&newest=2026-11-21/, "last 7 days too");
  assert.equal(calls.length, 10);

  assert.match(text, /^Data as of Sat 7 Nov, 21:00 \(Brussels\): wellness \(HRV\/RHR\) last recorded 6 Nov · last run 4 Nov · last ride none in 90 days$/m);
  assert.match(text, /^Morning check \(today\): not answered yet$/m);
  assert.match(text, /^Ladder gate \(Worker decision/m);
  assert.match(text, /^Plan check \(next 14 days, Worker rules\)/m);
  assert.match(text, /^Plan vs actual, last 7 days/m);
  assert.match(text, /^Runs, last 30 days: 8 sessions/m);
  assert.match(text, /- 4 Nov: 10×45 s, 7:30 running, run HR 142/);
  assert.match(text, /Next planned: 9 Nov 32:30 \(7:30 running\) · under the line/);
  assert.match(text, /Pain reports, last 14 days: none logged/);
  assert.match(text, /HRV 80 on 6 Nov/);
});

test("historySection: a failed part stays out, the rest still arrives", async () => {
  const down = () => new Response("down", { status: 503 });
  const { fetchImpl } = intervalsApi({ wellness: down(), events: down(), intervals: down() });
  const text = await historySection(makeEnv("k"), NOW, fetchImpl);
  assert.match(text, /^Runs, last 30 days: 8 sessions/m);
  assert.match(text, /- 4 Nov: run and walk segments unclear/);
  assert.match(text, /Plan check: calendar unavailable/);
  assert.match(text, /Next planned: calendar unavailable/);
  assert.match(text, /Wellness: unavailable/);
});

test("historySection: never throws, so a coach run doesn't depend on it", async () => {
  const { fetchImpl } = makeFetch(() => new Response("down", { status: 503 }));
  assert.match(await historySection(makeEnv("k"), NOW, fetchImpl), /^\(training history unavailable: Intervals HTTP 503/);
});

test("historySection: gives up after its time budget, so the run still starts in time", async () => {
  const { fetchImpl } = makeFetch(() => new Promise<Response>(() => {})); // Intervals never answers
  assert.match(
    await historySection(makeEnv("k"), NOW, fetchImpl, 20),
    /^\(training history unavailable: Intervals didn't answer within \d+ s\)$/,
  );
});

test("freshnessLines: a wellness gap is called out, so the coach doesn't guess", () => {
  const now = new Date("2026-11-09T09:00:00Z");
  const fresh = freshnessLines(RUNS, wellness(28), "2026-11-07", NOW);
  assert.equal(fresh.length, 1, "yesterday's data is fine");
  const stale = freshnessLines(RUNS, wellness(28), "2026-11-09", now);
  assert.match(stale[1]!, /^⚠️ No HRV\/RHR since 6 Nov: say the data is missing/);
  assert.match(freshnessLines(RUNS, undefined, "2026-11-09", now)[0]!, /wellness unavailable/);
});

test("noteLines and morningCheckLine: notes from messages, today's check", () => {
  const latest = RUNS[0]!;
  const notes = new Map([
    [latest.id, messageNotes([
      { content: "Feedback: legs heavy after 20 min", created: "2026-11-04T19:00:00Z" },
      { content: "Next morning (Sat 7 Nov): same", created: "2026-11-07T07:05:00Z" },
    ])],
  ]);
  assert.deepEqual(noteLines(RUNS, notes), [
    "Feedback notes, last 14 days (activity messages, newest activity first):",
    "- 4 Nov Run: legs heavy after 20 min",
    "- 4 Nov Run: next morning: same",
  ]);
  const days = [...wellness(27), { id: TODAY, fatigue: 3 }];
  assert.equal(morningCheckLine(days, RUNS, notes, TODAY), "Morning check (today): feels Tired (fatigue 3/4) · legs after the 4 Nov run: same");
  assert.equal(morningCheckLine(days, RUNS, notes, "2026-11-08"), "Morning check (today): not answered yet");
});
