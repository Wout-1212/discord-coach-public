import type { InteractionOption } from "./types.ts";

/**
 * `/report type`: a Montis report. The report tools run in the coach task, so this is a
 * `/coach` run with a fixed request; the prompt's ANSWERING section says how to post it.
 */

const REPORTS: Record<string, string> = {
  weekly: "Weekly report: run the Montis `run_weekly` tool.",
  season: "Season report: run the Montis `run_season` tool.",
  wellness: "Wellness report: run the Montis `run_wellness` tool.",
  summary: "Summary report: run the Montis `run_summary` tool.",
};

/** The coach request for the chosen report, or "" for an unknown type. */
export function reportRequest(options: InteractionOption[] = []): string {
  const type = options.find((o) => o.name === "type")?.value;
  return (typeof type === "string" && Object.hasOwn(REPORTS, type) && REPORTS[type]) || "";
}
