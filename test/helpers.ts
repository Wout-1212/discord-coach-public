import type { Env, KV } from "../src/types.ts";

/** In-memory KV (TTL is recorded but not enforced). */
export function makeKV(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const ttls = new Map<string, number | undefined>();
  const kv: KV = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value, options) => {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    delete: async (key) => void data.delete(key),
    list: async (options) => ({
      keys: [...data.keys()].filter((k) => k.startsWith(options?.prefix ?? "")).map((name) => ({ name })),
    }),
  };
  return { kv, data, ttls };
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A real Ed25519 key pair so tests sign requests exactly like Discord does. */
export async function makeSigner() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKeyHex = bytesToHex(await crypto.subtle.exportKey("raw", pair.publicKey));
  async function sign(timestamp: string, body: string): Promise<string> {
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" },
      pair.privateKey,
      new TextEncoder().encode(timestamp + body),
    );
    return bytesToHex(sig);
  }
  return { publicKeyHex, sign };
}

/** A POST to /interactions, signed like Discord does. */
export async function signedRequest(body: unknown, sign: (ts: string, body: string) => Promise<string>) {
  const raw = JSON.stringify(body);
  const ts = "1730000000";
  return new Request("https://coach.example.workers.dev/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": await sign(ts, raw), "X-Signature-Timestamp": ts },
    body: raw,
  });
}

export function makeEnv(publicKeyHex: string): Env {
  return {
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_BOT_TOKEN: "bot-token",
    ALLOWED_USER_ID: "owner-1",
    CLAUDE_TASK_ID: "trig_test123",
    CLAUDE_TASK_TOKEN: "sk-ant-oat01-test",
    HISTORY_LIMIT: "10",
    INTERVALS_ATHLETE_ID: "i123",
    INTERVALS_API_KEY: "icu-key",
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Fake fetch: records calls and answers from a route table. */
export function makeFetch(routes: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return routes(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    settle: () => Promise.all(pending),
    pending,
  };
}
