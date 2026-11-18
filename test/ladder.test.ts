import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSegments } from "../src/history.ts";
import type { IntervalsActivity } from "../src/intervals.ts";
import { LEVELS, hrCap, ladderGate, ladderLines, openPain, runLevel, sessionVerdict } from "../src/ladder.ts";
import { type Note, messageNotes } from "../src/notes.ts";

const TODAY = "2026-11-16";
const CAP = 149;
const seg = (longest: number, heartRate: number | undefined = 140): RunSegments => ({
  count: 10,
  totalSeconds: longest * 10,
  longestSeconds: longest,
  sameLength: true,
  heartRate,
});
const run = (day: string, level = 3, extra: Partial<IntervalsActivity> = {}): IntervalsActivity => ({
  id: `r-${day}`,
  type: "Run",
  name: `Run/Walk — L${level}`,
  start_date_local: `${day}T18:00:00`,
  moving_time: 2100,
  feel: 2,
  ...extra,
});
const morning = (answer: string, created = "2026-11-15T07:00:00Z"): Note[] =>
  messageNotes([{ content: `Next morning (Sun 15 Nov): ${answer}`, created }]);
const pain = (text: string): Note[] => messageNotes([{ content: `Pain: ${text}` }]);

/** Runs newest first, each clean at its level unless notes say otherwise. */
function gate(runs: { run: IntervalsActivity; notes?: Note[]; segments?: RunSegments }[], longestTime = 2400) {
  const notes = new Map(runs.map((r) => [r.run.id, r.notes ?? morning("no pain")]));
  return ladderGate(
    runs.map((r) => ({ run: r.run, segments: r.segments ?? seg(LEVELS[runLevel(r.run)! - 1]?.longestS ?? 60), notes: notes.get(r.run.id)! })),
    runs.map((r) => r.run),
    notes,
    TODAY,
    CAP,
    longestTime,
  );
}

test("LEVELS follow the running-zone-workouts ladder (L1 30/90 … L11 30 min continuous)", () => {
  assert.equal(LEVELS.length, 11);
  assert.deepEqual(
    LEVELS.map((l) => l.longestS),
    [30, 45, 60, 90, 120, 180, 300, 480, 720, 1200, 1800],
  );
  assert.equal(LEVELS[1]!.totalS, 32.5 * 60);
  assert.equal(hrCap({}), 149);
  assert.equal(hrCap({ RUN_HR_CAP: "152" }), 152);
});

test("runLevel: the L-number in the name first, else the longest run segment", () => {
  assert.equal(runLevel(run("2026-11-12", 2)), 2);
  assert.equal(runLevel({ ...run("2026-11-12"), name: "Run/Walk" }, seg(61)), 3);
  assert.equal(runLevel({ ...run("2026-11-12"), name: "Run/Walk" }, seg(75)), undefined, "between L3 and L4");
  assert.equal(runLevel({ ...run("2026-11-12"), name: "Morning run" }), undefined);
});

test("sessionVerdict: clean, not clean (with the reason) and bad", () => {
  const r = run("2026-11-12");
  assert.equal(sessionVerdict(r, seg(60), morning("no pain"), CAP).verdict, "clean");
  assert.deepEqual(sessionVerdict(run("2026-11-15"), seg(60), [], CAP).reasons, ["no next-morning check"]);
  assert.equal(sessionVerdict(run("2026-11-14"), seg(60), [], CAP).verdict, "clean", "before the morning check existed");
  assert.deepEqual(sessionVerdict(r, seg(60, 153), morning("same"), CAP).reasons, ["run HR 153 over the 149 cap"]);
  assert.deepEqual(sessionVerdict({ ...r, feel: 4 }, seg(60), morning("same"), CAP).reasons, ["felt Poor"]);
  assert.deepEqual(sessionVerdict(r, { ...seg(60), heartRate: undefined }, morning("same"), CAP).reasons, ["run HR unknown"]);

  const bad = sessionVerdict(r, seg(60), [...pain("calf 3/10, during"), ...morning("same")], CAP);
  assert.deepEqual([bad.verdict, bad.reasons], ["bad", ["pain 3/10"]]);
  assert.equal(sessionVerdict(run("2026-11-15"), seg(60), pain("knee 2/10, during"), CAP).verdict, "not clean", "2/10 is within the rule");
  assert.equal(sessionVerdict(r, seg(60), morning("worse"), CAP).verdict, "bad");
  assert.equal(sessionVerdict(r, seg(60), pain("shin 1/10, during, same, had to stop"), CAP).verdict, "bad");
});

test("ladderGate: advance after 2 clean sessions in a row at the current level", () => {
  const g = gate([{ run: run("2026-11-12") }, { run: run("2026-11-09") }]);
  assert.deepEqual([g.decision, g.current, g.allowed], ["advance", 3, 4]);
  assert.match(ladderLines(g)[0]!, /^Ladder gate \(Worker decision, follow it\): now L3 \(1:00\/1:30 ×10\) · next run at most L4 \(1:30\/1:30 ×8\), advance: 2 clean sessions/);
});

test("ladderGate: hold when one session isn't clean, or only one was at this level", () => {
  const unchecked = gate([{ run: run("2026-11-15"), notes: [] }, { run: run("2026-11-12") }]);
  assert.deepEqual([unchecked.decision, unchecked.allowed], ["hold", 3]);
  assert.match(unchecked.why, /15 Nov no next-morning check/);

  const lastWeek = gate([{ run: run("2026-11-14", 2), notes: [] }, { run: run("2026-11-09", 2), notes: [] }]);
  assert.deepEqual([lastWeek.decision, lastWeek.allowed], ["advance", 3], "9 and 14 Nov: no morning check existed yet");

  const justMoved = gate([{ run: run("2026-11-12", 3) }, { run: run("2026-11-09", 2) }]);
  assert.equal(justMoved.decision, "hold");
  assert.match(justMoved.why, /9 Nov was L2/);
});

test("ladderGate: drop a level after a bad session or 8+ days without a run", () => {
  const bad = gate([{ run: run("2026-11-12"), notes: pain("calf 4/10, during") }, { run: run("2026-11-09") }]);
  assert.deepEqual([bad.decision, bad.allowed], ["drop", 2]);
  assert.match(bad.why, /pain 4\/10/);

  const idle = gate([{ run: run("2026-11-05") }, { run: run("2026-11-03") }]);
  assert.deepEqual([idle.decision, idle.allowed, idle.why], ["drop", 2, "no run for 11 days"]);
  assert.equal(gate([{ run: run("2026-11-05", 1) }]).allowed, 1, "never below L1");
});

test("ladderGate: no advancing while a pain report is open, or over the +10% line", () => {
  const notes = [...pain("knee 1/10, right after"), ...morning("same")];
  const open = gate([{ run: run("2026-11-12"), notes }, { run: run("2026-11-09") }]);
  assert.equal(open.decision, "hold");
  assert.match(open.why, /pain report from 12 Nov still open/);

  const spike = gate([{ run: run("2026-11-12") }, { run: run("2026-11-09") }], 1800);
  assert.equal(spike.decision, "hold");
  assert.match(spike.why, /L4's 34:00 session is over the \+10% line \(33:00\)/);
});

test("ladderGate: start at L1 without runs; unknown level is said, not guessed", () => {
  assert.deepEqual([gate([]).decision, gate([]).allowed], ["start", 1]);
  const unknown = gate([{ run: { ...run("2026-11-12"), name: "Morning run" }, segments: seg(75) }]);
  assert.equal(unknown.decision, "unknown");
  assert.equal(unknown.allowed, undefined);
});

test("openPain: cleared by a later 'no pain' morning check", () => {
  const reported = run("2026-11-09");
  const later = run("2026-11-12");
  const notes = new Map([
    [reported.id, pain("calf 2/10")],
    [later.id, morning("no pain")],
  ]);
  assert.equal(openPain([later, reported], notes, TODAY), undefined);
  assert.equal(openPain([later, reported], new Map([[reported.id, pain("calf 2/10")]]), TODAY), "2026-11-09");
  assert.equal(openPain([reported], new Map([[reported.id, pain("calf 2/10")]]), "2026-12-01"), undefined, "older than 14 days");
});
