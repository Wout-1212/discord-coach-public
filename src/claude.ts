import type { Env } from "./types.ts";

/**
 * Start a run of the Claude scheduled task through its API trigger.
 * Docs: https://platform.claude.com/docs/en/api/claude-code/routines-fire
 *
 * Fire-and-forget: the API returns once the cloud session exists, not the answer.
 * The task itself posts its answer to Discord (see cloud/discord-post).
 * There is no idempotency key, so we never retry automatically (a retry could run twice).
 */

const MAX_TEXT_CHARS = 65_536;

export interface FireResult {
  ok: boolean;
  status: number;
  sessionUrl?: string;
  error?: string;
  retryAfterSeconds?: number;
}

export async function fireTask(
  env: Env,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FireResult> {
  const url = `https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(env.CLAUDE_TASK_ID)}/fire`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLAUDE_TASK_TOKEN}`,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: text.slice(0, MAX_TEXT_CHARS) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, status: 0, error: `network error: ${(err as Error).message}` };
  }

  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { claude_code_session_url?: string };
    return { ok: true, status: res.status, sessionUrl: body.claude_code_session_url };
  }

  const retryAfter = Number(res.headers.get("retry-after"));
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    if (body.error) message = `${body.error.type ?? "error"}: ${body.error.message ?? ""}`.trim();
  } catch {
    /* non-JSON error body */
  }
  return {
    ok: false,
    status: res.status,
    error: message,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  };
}

/** Human-readable advice for the error notice in Discord. */
export function explainFireError(result: FireResult): string {
  switch (result.status) {
    case 401:
      return "The task token was rejected. Generate a new API token for the task and run `npx wrangler secret put CLAUDE_TASK_TOKEN`.";
    case 403:
      return "This account has no access to the API trigger (needs Pro or higher with Claude Code on the web).";
    case 404:
      return "Task not found. Check CLAUDE_TASK_ID in wrangler.jsonc (it starts with trig_).";
    case 400:
      return "Request rejected — is the scheduled task paused?";
    case 429:
      return `Hourly limit reached.${result.retryAfterSeconds ? ` Try again in ~${Math.ceil(result.retryAfterSeconds / 60)} min.` : ""}`;
    default:
      return "Claude couldn't be reached right now. Try again in a minute.";
  }
}
