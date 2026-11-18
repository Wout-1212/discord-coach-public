import { isAnalysed, markAnalysed } from "./analysis.ts";
import { dispatchAutomated, postFireFailure } from "./automated.ts";
import { activityLabel } from "./feedback.ts";
import { type IntervalsActivity, brusselsDate, listRecentActivities } from "./intervals.ts";
import type { Env } from "./types.ts";
import { rideWeatherSection } from "./weather.ts";

/**
 * The coach's scheduled tasks, posted in #coach instead of as claude.ai notifications.
 * At a task's time (Europe/Brussels) the cron starts the coach task with "Automated <kind>",
 * pointing at the task's instructions in cloud/routines/ (read from the repo, so a push
 * changes them). Each task starts at most once a day (KV). The activity check only starts
 * for activities that got no automatic analysis (analysis.ts); the weekly review stays pinned
 * until the next one.
 */

export interface ScheduledTask {
  kind: string; // "morning brief": shown to the coach and in notices
  file: string; // instructions in cloud/routines/
  time: string; // "10:00", on the cron's 5-minute grid
  days?: number[]; // 0 = Sunday … 6 = Saturday; every day when left out
  emoji: string;
  pin?: string; // keep the latest answer pinned (watchdog.ts pinLatest); the answer starts with `emoji`
  mayStaySilent?: boolean; // the coach posts nothing when there's nothing to say: no watchdog warning
  /** What today's run should cover, added to the request; null = nothing to do, don't start the coach. */
  prepare?: (env: Env, now: Date, fetchImpl: typeof fetch) => Promise<Prepared | null>;
}

export interface Prepared {
  request: string;
  /** Called once the run has started. */
  started?: () => Promise<void>;
}

// The morning brief runs at 10:00 so last night's Garmin data has synced, the weekend outlook
// after the 19:00 weather check.
export const TASKS: ScheduledTask[] = [
  { kind: "morning brief", file: "morning-brief.md", time: "10:00", emoji: "☀️" },
  { kind: "activity check", file: "activity-check.md", time: "20:35", emoji: "📊", prepare: unanalysedActivities, mayStaySilent: true },
  { kind: "weekend outlook", file: "weekend-outlook.md", time: "19:45", days: [4], emoji: "🗓️" },
  { kind: "weekly review", file: "weekly-review.md", time: "19:40", days: [0], emoji: "📈", pin: "weekly-review" },
];

const DONE_TTL_S = 2 * 86_400;

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Brussels",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The cron's 5-minute slot in Brussels time, "08:00" for 08:00–08:04. */
export function brusselsSlot(now: Date): string {
  const [hour = "", minute = ""] = clock.format(now).split(":");
  return `${hour}:${String(Number(minute) - (Number(minute) % 5)).padStart(2, "0")}`;
}

export function dueTasks(now: Date, tasks: ScheduledTask[] = TASKS): ScheduledTask[] {
  const time = brusselsSlot(now);
  const weekday = new Date(`${brusselsDate.format(now)}T00:00:00Z`).getUTCDay();
  return tasks.filter((t) => t.time === time && (!t.days || t.days.includes(weekday)));
}

/**
 * The activity check's work: activities from today and yesterday that weren't analysed yet
 * (no feedback pop-up, or an earlier check). Marked analysed once the check has started, so
 * each one is covered once, also when it synced after the previous check.
 */
export async function unanalysedActivities(env: Env, now: Date, fetchImpl: typeof fetch = fetch): Promise<Prepared | null> {
  const activities = await listRecentActivities(env, now, 1, fetchImpl);
  const open: IntervalsActivity[] = [];
  for (const a of activities.reverse()) if (!(await isAnalysed(env, a.id))) open.push(a);
  if (!open.length) return null;
  return {
    request: [
      "Activities to cover (no automatic analysis yet):",
      ...open.map((a) => `- ${activityLabel(a)} (Intervals id ${a.id})`),
    ].join("\n"),
    started: async () => {
      for (const a of open) await markAnalysed(env, a.id);
    },
  };
}

/** Called from the cron every 5 minutes. Returns how many tasks were started. */
export async function runScheduledTasks(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  tasks: ScheduledTask[] = TASKS,
): Promise<number> {
  if (!env.STATE || !env.DISCORD_WEBHOOK_URL) return 0;
  let started = 0;
  for (const task of dueTasks(now, tasks)) {
    // Once a day, also if the cron fires twice; a run that fails to start isn't retried.
    const key = `scheduled:${task.file}:${brusselsDate.format(now)}`;
    if (await env.STATE.get(key)) continue;
    await env.STATE.put(key, "1", { expirationTtl: DONE_TTL_S });

    let prepared: Prepared | null | undefined;
    if (task.prepare) {
      prepared = await task.prepare(env, now, fetchImpl).catch((err): Prepared => {
        console.error(`${task.kind}: check failed, starting anyway:`, (err as Error).message);
        return { request: "" };
      });
      if (!prepared) continue;
    }

    const request = `Do the scheduled ${task.kind}: read \`cloud/routines/${task.file}\` in the repository and follow it.`;
    const result = await dispatchAutomated(
      env,
      {
        kind: task.kind,
        request: prepared?.request ? `${request}\n\n${prepared.request}` : request,
        weather: rideWeatherSection(env, now, fetchImpl),
        now,
        notice: `${task.emoji} Scheduled ${task.kind}`,
        pin: task.pin,
        pinPrefix: task.pin ? task.emoji : undefined,
        track: !task.mayStaySilent,
      },
      fetchImpl,
    );
    if (result.ok) {
      started++;
      await prepared?.started?.();
    } else await postFireFailure(env, task.kind, result, fetchImpl);
  }
  return started;
}
