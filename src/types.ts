/** The name the coach prompt uses in its rules ("Wout's message"); not the Discord display name. */
export const OWNER_NAME = "Wout";

/** Settings and secrets the Worker reads (wrangler.jsonc "vars" + `wrangler secret put`). */
export interface Env {
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string; // secret
  ALLOWED_USER_ID: string;
  CLAUDE_TASK_ID: string; // trig_…
  CLAUDE_TASK_TOKEN: string; // secret, sk-ant-oat01-… (per-task API trigger token)
  HISTORY_LIMIT?: string;
  COACH_CHANNEL_ID?: string; // #coach; messages older than DELETE_AFTER_HOURS are deleted hourly
  DELETE_AFTER_HOURS?: string;
  INTERVALS_ATHLETE_ID: string; // i…, for /feedback and /plan
  INTERVALS_API_KEY?: string; // secret, Intervals → Settings → Developer Settings
  DISCORD_WEBHOOK_URL?: string; // secret, the app-owned "Coach" webhook (activity nudges)
  WATCHDOG_MINUTES?: string; // warn when a /coach request has no answer after this long
  WEATHER_LAT?: string; // where rides start (default Brussels), for the Open-Meteo forecast
  WEATHER_LON?: string;
  OUTDOOR_MIN_FEELS_C?: string; // outdoor rule (weather.ts), defaults 5 °C, 30 km/h, 3 h
  OUTDOOR_MAX_WIND_KMH?: string;
  OUTDOOR_MIN_HOURS?: string;
  OUTDOOR_DAYS?: string; // weekdays an indoor Z2 ride may go outdoors, "fri,sat,sun"; plus "Home week" notes
  RUN_HR_CAP?: string; // run-segment HR cap for the ladder gate (ladder.ts), default 149 = run Z1 top
  STATE?: KV; // KV namespace: pending requests, nudged activities, button locks, weather flags
}

/** The part of Cloudflare's KV namespace API we use. */
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

/** The part of Cloudflare's ExecutionContext we use. */
export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

// --- Minimal Discord shapes (only the fields we read) ---

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  Autocomplete: 4,
  ModalSubmit: 5,
} as const;
export const ResponseType = {
  Pong: 1,
  ChannelMessage: 4,
  DeferredChannelMessage: 5,
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
  AutocompleteResult: 8,
  Modal: 9,
} as const;
export const MessageFlags = { Ephemeral: 64 } as const;

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string; // slash commands
    options?: InteractionOption[];
    custom_id?: string; // button clicks and modal submits
    components?: ModalLabel[]; // modal submits: what was filled in
  };
  message?: DiscordMessage; // button clicks and their modals: the message the button is on
}

/** One field of a submitted modal. */
export interface ModalLabel {
  component?: { custom_id?: string; value?: string; values?: string[] };
}

export interface InteractionOption {
  name: string;
  type: number;
  value: string | number;
  focused?: boolean; // autocomplete: the option being typed in
}

export interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author: DiscordUser & { bot?: boolean };
  webhook_id?: string;
  pinned?: boolean;
  interaction_metadata?: { id: string; user?: DiscordUser };
  embeds?: { title?: string; description?: string }[];
  components?: unknown[];
}

export interface Button {
  type: 2;
  style: 1 | 2 | 3 | 4; // primary, secondary, success, danger
  label: string;
  custom_id: string;
}

/** One row of buttons under a message. */
export function buttonRow(buttons: Omit<Button, "type">[]) {
  return { type: 1, components: buttons.map((b) => ({ type: 2, ...b })) };
}
