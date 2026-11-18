import { FEEDBACK_PREFIX, NEXT_MORNING_PREFIX, PAIN_PREFIX } from "./feedback.ts";
import { type IntervalsActivity, addDays, listActivityMessages } from "./intervals.ts";
import type { Env } from "./types.ts";

/**
 * Wout's words about an activity: messages under it (feedback.ts writes "Feedback: …",
 * "Pain: …"; checkin.ts "Next morning (…): …"), plus the older lines in the description from
 * before notes moved out of it. Montis doesn't show messages, so the Worker passes them on.
 */

export type NoteKind = "feedback" | "pain" | "next-morning" | "note";

export interface Note {
  kind: NoteKind;
  text: string; // without the prefix
  created?: string; // ISO time, for messages
}

export type NextMorning = "none" | "better" | "same" | "worse";
export const NEXT_MORNING_ANSWERS: Record<NextMorning, string> = {
  none: "no pain",
  better: "better",
  same: "same",
  worse: "worse",
};

function parse(line: string, created?: string): Note {
  const text = line.trim();
  if (text.startsWith(FEEDBACK_PREFIX)) return { kind: "feedback", text: text.slice(FEEDBACK_PREFIX.length).trim(), created };
  if (text.startsWith(PAIN_PREFIX)) return { kind: "pain", text: text.slice(PAIN_PREFIX.length).trim(), created };
  if (text.startsWith(NEXT_MORNING_PREFIX)) {
    return { kind: "next-morning", text: text.slice(text.indexOf(":") + 1).trim().toLowerCase(), created };
  }
  return { kind: "note", text, created };
}

/** "Feedback:" and "Pain:" lines in a description (older activities only). */
export function descriptionNotes(description: string | null | undefined): Note[] {
  return (description ?? "")
    .split("\n")
    .filter((line) => line.startsWith(FEEDBACK_PREFIX) || line.startsWith(PAIN_PREFIX))
    .map((line) => parse(line));
}

export function messageNotes(messages: { content?: string | null; created?: string | null }[]): Note[] {
  return messages.filter((m) => m.content?.trim()).map((m) => parse(m.content!, m.created ?? undefined));
}

/** "calf 3/10, during" → 3; undefined without a score. */
export function painScore(text: string): number | undefined {
  const match = /(\d+)\s*\/\s*10/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** The next-morning answer on an activity, if any (the latest one counts). */
export function nextMorning(notes: Note[]): NextMorning | undefined {
  const answer = notes.filter((n) => n.kind === "next-morning").at(-1)?.text;
  return (Object.keys(NEXT_MORNING_ANSWERS) as NextMorning[]).find((k) => NEXT_MORNING_ANSWERS[k] === answer);
}

/**
 * Notes per activity id for the activities of the last `days` days. A failed read leaves
 * that activity's messages out (its description lines still count). Never throws.
 */
export async function recentNotes(
  env: Env,
  activities: IntervalsActivity[],
  today: string,
  days: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Note[]>> {
  const since = addDays(today, -days);
  const recent = activities.filter((a) => a.start_date_local.slice(0, 10) >= since);
  const messages = await Promise.all(
    recent.map((a) =>
      listActivityMessages(env, a.id, fetchImpl).catch((err) => {
        console.error(`notes of ${a.id} failed:`, (err as Error).message);
        return [];
      }),
    ),
  );
  return new Map(recent.map((a, i) => [a.id, [...descriptionNotes(a.description), ...messageNotes(messages[i]!)]]));
}
