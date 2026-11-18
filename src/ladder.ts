import { FEEL_LABELS } from "./feedback.ts";
import type { RunSegments } from "./history.ts";
import type { IntervalsActivity } from "./intervals.ts";
import { type Note, nextMorning, painScore } from "./notes.ts";
import { SPIKE_FACTOR, clock, dayOf, daysBetween, shortDate } from "./sessions.ts";
import type { Env } from "./types.ts";

/**
 * The run/walk ladder as code: the Worker decides the level, the coach explains it. Levels and
 * rules are the `running-zone-workouts` skill, section 5, and the pain rule in section 6 of the
 * context doc. Change them here (and in the skill), deliberately:
 *  - advance one level after 2 clean sessions in a row at the current level;
 *  - a clean session: run-segment HR at or under the cap, no pain above 2/10, it didn't feel
 *    Poor or Weak, and the next morning wasn't worse (and was checked, for runs from 15 Nov 2026
 *    on: the morning check only exists since then);
 *  - drop one level after a bad session (pain above 2/10, worse next morning, had to stop)
 *    or 8+ days without a run;
 *  - otherwise hold. No advancing while a pain report is open, or when the next level's session
 *    would be over the +10% line.
 */

export interface Level {
  n: number;
  structure: string; // "1:00/1:30 ×10"
  longestS: number; // longest run segment
  totalS: number; // whole session incl. the 5-min walks
}

export const LEVELS: Level[] = [
  { n: 1, structure: "0:30/1:30 ×10", longestS: 30, totalS: 30 * 60 },
  { n: 2, structure: "0:45/1:30 ×10", longestS: 45, totalS: 32.5 * 60 },
  { n: 3, structure: "1:00/1:30 ×10", longestS: 60, totalS: 35 * 60 },
  { n: 4, structure: "1:30/1:30 ×8", longestS: 90, totalS: 34 * 60 },
  { n: 5, structure: "2:00/1:00 ×8", longestS: 120, totalS: 34 * 60 },
  { n: 6, structure: "3:00/1:00 ×6", longestS: 180, totalS: 34 * 60 },
  { n: 7, structure: "5:00/1:00 ×4", longestS: 300, totalS: 34 * 60 },
  { n: 8, structure: "8:00/1:00 ×3", longestS: 480, totalS: 37 * 60 },
  { n: 9, structure: "12 min + 12 min", longestS: 720, totalS: 35 * 60 },
  { n: 10, structure: "20 min + 8 min", longestS: 1200, totalS: 39 * 60 },
  { n: 11, structure: "30 min continuous", longestS: 1800, totalS: 40 * 60 },
];

const MAX_PAIN = 2; // /10 during runs (context doc section 6)
const MISSED_DAYS = 8;
const OPEN_PAIN_DAYS = 14;
const LEVEL_TOLERANCE = 0.15;
const DEFAULT_HR_CAP = 149; // run Z1 top; the run zones are provisional (context doc section 7)
// The first 08:00 morning check (checkin.ts went live the evening of 15 Nov). A run whose next
// morning came before it couldn't be checked, so a missing answer doesn't count against it.
const FIRST_MORNING_CHECK = "2026-11-16";
const morningCheckExpected = (run: IntervalsActivity) => daysBetween(dayOf(run), FIRST_MORNING_CHECK) <= 1;

export function hrCap(env: Pick<Env, "RUN_HR_CAP">): number {
  const cap = Number(env.RUN_HR_CAP);
  return env.RUN_HR_CAP?.trim() && cap > 0 ? cap : DEFAULT_HR_CAP;
}

export const levelLabel = (n: number) => `L${n} (${LEVELS[n - 1]?.structure ?? "?"})`;

/** "L3" in a planned workout's or activity's name. */
export function levelInName(name: string | null | undefined): number | undefined {
  const n = Number(/\bL(\d{1,2})\b/.exec(name ?? "")?.[1]);
  return n >= 1 && n <= LEVELS.length ? n : undefined;
}

/** The level of a run: from its name (the workouts carry "L3"), else from its longest run segment. */
export function runLevel(run: IntervalsActivity, segments?: RunSegments): number | undefined {
  const named = levelInName(run.name);
  if (named) return named;
  if (!segments) return undefined;
  return LEVELS.find((l) => Math.abs(segments.longestSeconds - l.longestS) <= l.longestS * LEVEL_TOLERANCE)?.n;
}

export type Verdict = "clean" | "not clean" | "bad";

export interface Session {
  run: IntervalsActivity;
  level?: number;
  verdict: Verdict;
  reasons: string[];
}

export function sessionVerdict(run: IntervalsActivity, segments: RunSegments | undefined, notes: Note[], cap: number): Session {
  const bad: string[] = [];
  const notClean: string[] = [];
  for (const pain of notes.filter((n) => n.kind === "pain")) {
    const score = painScore(pain.text);
    if (score !== undefined && score > MAX_PAIN) bad.push(`pain ${score}/10`);
    if (/had to stop/i.test(pain.text)) bad.push("had to stop");
  }
  const morning = nextMorning(notes);
  if (morning === "worse") bad.push("worse the next morning");
  else if (!morning && morningCheckExpected(run)) notClean.push("no next-morning check");

  if (segments?.heartRate === undefined) notClean.push("run HR unknown");
  else if (segments.heartRate > cap) notClean.push(`run HR ${segments.heartRate} over the ${cap} cap`);
  if ((run.feel ?? 0) >= 4) notClean.push(`felt ${FEEL_LABELS[run.feel! - 1]}`);

  const level = runLevel(run, segments);
  if (bad.length) return { run, level, verdict: "bad", reasons: bad };
  return { run, level, verdict: notClean.length ? "not clean" : "clean", reasons: notClean };
}

/** A pain report in the last 14 days with no "no pain" next-morning answer on that day or later. */
export function openPain(activities: IntervalsActivity[], notes: Map<string, Note[]>, today: string): string | undefined {
  const dated = activities
    .map((a) => ({ day: dayOf(a), notes: notes.get(a.id) ?? [] }))
    .filter((a) => daysBetween(a.day, today) <= OPEN_PAIN_DAYS);
  const reports = dated.filter((a) => a.notes.some((n) => n.kind === "pain")).map((a) => a.day).sort();
  const latest = reports.at(-1);
  if (!latest) return undefined;
  const cleared = dated.some((a) => a.day >= latest && nextMorning(a.notes) === "none");
  return cleared ? undefined : latest;
}

export interface LadderGate {
  current?: number;
  allowed?: number; // the highest level the next run may be
  decision: "advance" | "hold" | "drop" | "start" | "unknown";
  why: string;
  sessions: Session[];
}

/**
 * The decision for the next run. `runs`: newest first, with their segments and notes.
 * `longestTime`: the longest run session of the last 30 days (for the +10% line).
 */
export function ladderGate(
  runs: { run: IntervalsActivity; segments?: RunSegments; notes: Note[] }[],
  allActivities: IntervalsActivity[],
  notes: Map<string, Note[]>,
  today: string,
  cap: number,
  longestTime?: number,
): LadderGate {
  const sessions = runs.slice(0, 3).map((r) => sessionVerdict(r.run, r.segments, r.notes, cap));
  const latest = sessions[0];
  if (!latest) return { allowed: 1, decision: "start", why: "no runs in the last 90 days: start at L1", sessions };
  const current = latest.level;
  if (!current) {
    return {
      decision: "unknown",
      why: "the last run's level can't be told (no L-number in its name, segments don't match a level): use the skill's table and say so",
      sessions,
    };
  }

  const idle = daysBetween(dayOf(latest.run), today);
  if (idle >= MISSED_DAYS) {
    return { current, allowed: Math.max(1, current - 1), decision: "drop", why: `no run for ${idle} days`, sessions };
  }
  if (latest.verdict === "bad") {
    return { current, allowed: Math.max(1, current - 1), decision: "drop", why: `${shortDate(dayOf(latest.run))}: ${latest.reasons.join(", ")}`, sessions };
  }

  const hold = (why: string): LadderGate => ({ current, allowed: current, decision: "hold", why, sessions });
  const pain = openPain(allActivities, notes, today);
  if (pain) return hold(`pain report from ${shortDate(pain)} still open (no "no pain" morning check since)`);
  if (current >= LEVELS.length) return hold("top of the ladder: 30 min continuous (phase 2 of the skill)");

  const lastTwo = sessions.slice(0, 2);
  const notYet = lastTwo.filter((s) => s.level !== current || s.verdict !== "clean");
  if (lastTwo.length < 2 || notYet.length) {
    const why = notYet.length
      ? notYet.map((s) => `${shortDate(dayOf(s.run))} ${s.level !== current ? `was ${s.level ? `L${s.level}` : "another level"}` : s.reasons.join(", ")}`).join("; ")
      : `only 1 session at L${current} so far`;
    return hold(`needs 2 clean sessions in a row at L${current}: ${why}`);
  }

  const next = LEVELS[current]!; // the level above (n = current + 1)
  if (longestTime && next.totalS > longestTime * SPIKE_FACTOR) {
    return hold(`L${next.n}'s ${clock(next.totalS)} session is over the +10% line (${clock(longestTime * SPIKE_FACTOR)})`);
  }
  return { current, allowed: next.n, decision: "advance", why: `2 clean sessions in a row at L${current}`, sessions };
}

const DECISION_TEXT = { advance: "advance", hold: "hold", drop: "drop a level", start: "start", unknown: "unknown" } as const;

/** The block lines: the decision first, then the sessions it's based on. */
export function ladderLines(gate: LadderGate): string[] {
  const head =
    gate.allowed === undefined
      ? `Ladder gate (Worker decision): level unknown, ${gate.why}`
      : `Ladder gate (Worker decision, follow it): ${gate.current ? `now ${levelLabel(gate.current)} · ` : ""}next run at most ${levelLabel(gate.allowed)}, ${DECISION_TEXT[gate.decision]}: ${gate.why}`;
  return [
    head,
    ...gate.sessions.map(
      (s) => `- ${shortDate(dayOf(s.run))} ${s.level ? `L${s.level}` : "level ?"}: ${s.verdict}${s.reasons.length ? ` (${s.reasons.join(", ")})` : ""}`,
    ),
  ];
}
