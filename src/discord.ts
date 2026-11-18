import type { DiscordMessage, Env } from "./types.ts";

export const DISCORD_API = "https://discord.com/api/v10";
export const USER_AGENT = "DiscordBot (https://github.com/Wout-1212/discord-coach, 1.0.0)";

/** Last line of the acknowledgement message; used to recognise and strip it from history. */
export const ACK_MARKER = "🧠 _Coach is on it — the answer follows here in about a minute._";

const MAX_CHARS_PER_MESSAGE = 1500;
const MAX_HISTORY_CHARS = 20_000;

/** The message Discord shows immediately when you run /coach (the user's question, quoted). */
export function buildAck(question: string): string {
  const quoted = question
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n${ACK_MARKER}`;
}

/** Recover the original question from an acknowledgement message (status lines below the marker are dropped). */
export function questionFromAck(content: string): string {
  const lines = content.split("\n");
  const marker = lines.indexOf(ACK_MARKER);
  return (marker === -1 ? lines : lines.slice(0, marker))
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
}

/** Read the most recent messages in the channel (newest first, as Discord returns them). */
export async function fetchRecentMessages(
  env: Env,
  channelId: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordMessage[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 0, 0), 50);
  if (safeLimit === 0) return [];
  const res = await fetchImpl(
    `${DISCORD_API}/channels/${channelId}/messages?limit=${safeLimit}`,
    {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Discord history HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as DiscordMessage[];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Brussels",
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatBrusselsTime(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return timeFormat.format(date);
}

interface HistoryOptions {
  /** The current interaction; its own acknowledgement is skipped (the question is sent separately). */
  excludeInteractionId?: string;
  applicationId: string;
  ownerName: string;
}

/**
 * Turn Discord messages (newest first) into a plain transcript (oldest first).
 * Labels: the owner's /coach questions, the webhook's name for its posts ("Coach" replies,
 * "Intervals" activity nudges), "System" for the Worker's own replies (/plan, /feedback, errors).
 */
export function formatHistory(messages: DiscordMessage[], opts: HistoryOptions): string {
  const lines: string[] = [];
  for (const msg of [...messages].reverse()) {
    if (opts.excludeInteractionId && msg.interaction_metadata?.id === opts.excludeInteractionId) {
      continue;
    }

    let speaker: string;
    let text = msg.content ?? "";

    if (msg.webhook_id) {
      speaker = msg.author?.username || "Coach";
    } else if (msg.interaction_metadata && text.includes(ACK_MARKER)) {
      speaker = opts.ownerName;
      text = questionFromAck(text);
    } else if (msg.interaction_metadata || msg.author?.id === opts.applicationId) {
      speaker = "System";
    } else {
      speaker = msg.author?.global_name || msg.author?.username || "Unknown";
    }

    if (!text.trim() && msg.embeds?.length) {
      text = msg.embeds
        .map((e) => [e.title, e.description].filter(Boolean).join(": "))
        .join("\n");
    }
    if (!text.trim()) continue;

    lines.push(
      `[${formatBrusselsTime(msg.timestamp)}] ${speaker}: ${truncate(text.trim(), MAX_CHARS_PER_MESSAGE)}`,
    );
  }

  // Keep the newest part if the transcript is too long.
  while (lines.length > 1 && lines.join("\n").length > MAX_HISTORY_CHARS) {
    lines.shift();
  }
  return lines.join("\n");
}

/**
 * Edit the interaction's message: the "thinking…" placeholder of a deferred response, the
 * /coach acknowledgement, or (for button clicks) the message the button is on.
 * `components`: new buttons; [] removes them, undefined leaves them as they are.
 */
export async function editOriginal(
  env: Env,
  interactionToken: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
  components?: unknown[],
): Promise<void> {
  const res = await fetchImpl(
    `${DISCORD_API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({
        content: truncate(content, 1900),
        allowed_mentions: { parse: [] },
        ...(components ? { components } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!res.ok) throw new Error(`Discord edit HTTP ${res.status}`);
}

/** Post to #coach through the app-owned webhook (DISCORD_WEBHOOK_URL), which may carry buttons. */
export async function postWebhook(
  env: Env,
  message: { content: string; username: string; components?: unknown[] },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL?.trim();
  if (!url) throw new Error("DISCORD_WEBHOOK_URL is not set");
  const res = await fetchImpl(`${url}${url.includes("?") ? "&" : "?"}wait=true&with_components=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      content: truncate(message.content, 1900),
      username: message.username,
      allowed_mentions: { parse: [] },
      ...(message.components ? { components: message.components } : {}),
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Post an extra message under the original /coach interaction (used for error notices). */
export async function postFollowup(
  env: Env,
  interactionToken: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${DISCORD_API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ content: truncate(content, 1900), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Discord follow-up HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
