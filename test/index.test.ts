import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAck } from "../src/discord.ts";
import { handleRequest } from "../src/index.ts";
import { makeCtx, makeEnv, makeFetch, makeKV, makeSigner, signedRequest } from "./helpers.ts";

function coachInteraction(userId: string, message: string) {
  return {
    id: "interaction-9",
    application_id: "app-1",
    type: 2,
    token: "interaction-token",
    channel_id: "chan-1",
    member: { user: { id: userId, username: "wout", global_name: "Wout" } },
    data: { name: "coach", options: [{ name: "message", type: 3, value: message }] },
  };
}

test("GET / is a health check; other paths 404", async () => {
  const { publicKeyHex } = await makeSigner();
  const { ctx } = makeCtx();
  const env = makeEnv(publicKeyHex);
  assert.equal((await handleRequest(new Request("https://x/"), env, ctx)).status, 200);
  assert.equal((await handleRequest(new Request("https://x/nope"), env, ctx)).status, 404);
});

test("unsigned or badly signed requests get 401", async () => {
  const { publicKeyHex } = await makeSigner();
  const other = await makeSigner();
  const { ctx } = makeCtx();
  const env = makeEnv(publicKeyHex);
  const unsigned = new Request("https://x/interactions", { method: "POST", body: "{}" });
  assert.equal((await handleRequest(unsigned, env, ctx)).status, 401);
  const wrongKey = await signedRequest({ type: 1 }, other.sign);
  assert.equal((await handleRequest(wrongKey, env, ctx)).status, 401);
});

test("PING gets PONG", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx } = makeCtx();
  const res = await handleRequest(await signedRequest({ type: 1 }, sign), makeEnv(publicKeyHex), ctx);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("someone else is refused privately and nothing is started", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const { fetchImpl, calls } = makeFetch(() => new Response("{}"));
  const res = await handleRequest(
    await signedRequest(coachInteraction("intruder", "delete my calendar"), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  const body = (await res.json()) as { type: number; data: { content: string; flags: number } };
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /private/);
  assert.equal(pending.length, 0);
  assert.equal(calls.length, 0);
});

test("owner: instant ack, then history + task fire with the right request", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const history = [
    {
      id: "m2",
      content: buildAck("analyse today's ride"),
      timestamp: "2026-11-03T14:20:00Z",
      author: { id: "app-1", username: "Coach", bot: true },
      interaction_metadata: { id: "interaction-9" }, // the current ack: must be skipped
    },
    {
      id: "m1",
      content: "Your Friday ride is still planned.",
      timestamp: "2026-11-03T13:00:00Z",
      author: { id: "wh", username: "Coach", bot: true },
      webhook_id: "wh",
    },
  ];
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.startsWith("https://discord.com/api/v10/channels/chan-1/messages")) {
      return Response.json(history);
    }
    if (call.url.startsWith("https://api.anthropic.com/")) {
      return Response.json({
        type: "routine_fire",
        claude_code_session_id: "session_1",
        claude_code_session_url: "https://claude.ai/code/session_1",
      });
    }
    return new Response("unexpected", { status: 500 });
  });

  const res = await handleRequest(
    await signedRequest(coachInteraction("owner-1", "  analyse today's ride  "), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  const body = (await res.json()) as { type: number; data: { content: string; flags?: number } };
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, undefined, "ack is visible in the channel (becomes history)");
  assert.equal(body.data.content, buildAck("analyse today's ride"));

  await settle();
  // Intervals fails here too, for the training history block: the run still starts.
  const intervalsCalls = calls.filter((c) => c.url.includes("intervals.icu"));
  assert.equal(intervalsCalls.length, 3);
  const otherCalls = calls.filter((c) => !c.url.includes("intervals.icu"));
  assert.equal(otherCalls.length, 4);

  // The forecast for the ride weather block (fails here: the run still starts).
  const [forecastCall, historyCall, fireCall, editCall] = otherCalls;
  assert.match(forecastCall!.url, /^https:\/\/api\.open-meteo\.com\//);
  assert.equal(historyCall!.url, "https://discord.com/api/v10/channels/chan-1/messages?limit=11");
  assert.equal(historyCall!.headers["authorization"], "Bot bot-token");

  assert.equal(fireCall!.url, "https://api.anthropic.com/v1/claude_code/routines/trig_test123/fire");
  assert.equal(fireCall!.method, "POST");
  assert.equal(fireCall!.headers["authorization"], "Bearer sk-ant-oat01-test");
  assert.equal(fireCall!.headers["anthropic-version"], "2023-06-01");
  const sent = JSON.parse(fireCall!.body!) as { text: string };
  assert.match(sent.text, /=== Wout's message \(this is the request\) ===\nanalyse today's ride\n/);
  assert.match(sent.text, /Coach: Your Friday ride is still planned\./);
  assert.equal(sent.text.match(/analyse today's ride/g)?.length, 1, "current ack not duplicated");
  assert.match(sent.text, /=== Ride weather, next 7 days .*\n\(forecast unavailable: Open-Meteo HTTP 500/);
  assert.match(sent.text, /=== Training history .*\n\(training history unavailable: Intervals HTTP 500/);
  assert.ok(
    sent.text.indexOf("=== Training history") < sent.text.indexOf("=== Recent messages"),
    "before the channel history, which is what gets cut when the text is too long",
  );

  // The ack gets the session link, and keeps the question recoverable for history.
  assert.equal(editCall!.method, "PATCH");
  assert.equal(editCall!.url, "https://discord.com/api/v10/webhooks/app-1/interaction-token/messages/@original");
  assert.equal(
    JSON.parse(editCall!.body!).content,
    `${buildAck("analyse today's ride")}\n-# 🔗 [Cloud session](<https://claude.ai/code/session_1>)`,
  );
});

test("owner: a started run is handed to the watchdog", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { kv, data } = makeKV();
  const env = { ...makeEnv(publicKeyHex), STATE: kv };
  const { fetchImpl } = makeFetch((call) =>
    call.url.includes("anthropic.com")
      ? Response.json({ claude_code_session_url: "https://claude.ai/code/s" })
      : Response.json([]),
  );
  await handleRequest(await signedRequest(coachInteraction("owner-1", "hi"), sign), env, ctx, fetchImpl);
  await settle();
  const run = JSON.parse(data.get("pending:interaction-9")!);
  assert.equal(run.token, "interaction-token");
  assert.equal(run.channelId, "chan-1");
  assert.equal(run.sessionUrl, "https://claude.ai/code/s");
  assert.ok(run.message.startsWith(buildAck("hi")));
});

test("owner: the run is tracked even when the session link can't be added", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { kv, data } = makeKV();
  const env = { ...makeEnv(publicKeyHex), STATE: kv };
  const { fetchImpl } = makeFetch((call) => {
    if (call.url.includes("anthropic.com")) return Response.json({ claude_code_session_url: "https://claude.ai/code/s" });
    if (call.method === "PATCH") return new Response("down", { status: 503 });
    return Response.json([]);
  });
  await handleRequest(await signedRequest(coachInteraction("owner-1", "hi"), sign), env, ctx, fetchImpl);
  await settle();
  assert.ok(data.has("pending:interaction-9"));
});

test("history failure still fires the task, with a note", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) =>
    call.url.includes("discord.com")
      ? new Response("Missing Access", { status: 403 })
      : Response.json({ claude_code_session_url: "https://claude.ai/code/s" }),
  );
  await handleRequest(
    await signedRequest(coachInteraction("owner-1", "hi"), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  await settle();
  const fire = calls.find((c) => c.url.includes("anthropic.com"));
  assert.ok(fire);
  assert.match(JSON.parse(fire!.body!).text, /earlier messages could not be loaded/);
});

test("fire failure posts a clear notice under the interaction", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.includes("/channels/")) return Response.json([]);
    if (call.url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Too many fires" } }),
        { status: 429, headers: { "retry-after": "600" } },
      );
    }
    return new Response(null, { status: 204 });
  });
  await handleRequest(
    await signedRequest(coachInteraction("owner-1", "hi"), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  await settle();
  const followup = calls.find((c) => c.url.includes("/webhooks/app-1/interaction-token"));
  assert.ok(followup, "follow-up posted");
  const content = JSON.parse(followup!.body!).content as string;
  assert.match(content, /^⚠️ Couldn't start the coach \(rate_limit_error: Too many fires\)/);
  assert.match(content, /Try again in ~10 min/);
});

function reportInteraction(userId: string, type: string) {
  const base = coachInteraction(userId, "");
  return { ...base, data: { name: "report", options: [{ name: "type", type: 3, value: type }] } };
}

test("/report starts the coach with the fixed request for that report", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) =>
    call.url.includes("anthropic.com") ? Response.json({}) : Response.json([]),
  );
  const res = await handleRequest(
    await signedRequest(reportInteraction("owner-1", "season"), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  const body = (await res.json()) as { type: number; data: { content: string; flags?: number } };
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, undefined);
  assert.match(body.data.content, /Season report/);
  await settle();
  const fire = calls.find((c) => c.url.includes("anthropic.com"));
  assert.match(JSON.parse(fire!.body!).text, /=== Wout's message \(this is the request\) ===\nSeason report: run the Montis `run_season` tool\./);
});

test("/report refuses others and unknown types, and starts nothing", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const env = makeEnv(publicKeyHex);
  for (const [user, type, text] of [
    ["intruder", "weekly", /private/],
    ["owner-1", "nope", /Pick a report type/],
    ["owner-1", "constructor", /Pick a report type/],
  ] as const) {
    const res = await handleRequest(await signedRequest(reportInteraction(user, type), sign), env, ctx);
    const body = (await res.json()) as { data: { content: string; flags: number } };
    assert.equal(body.data.flags, 64);
    assert.match(body.data.content, text);
  }
  assert.equal(pending.length, 0);
});

test("empty message is answered privately", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const res = await handleRequest(
    await signedRequest(coachInteraction("owner-1", "   "), sign),
    makeEnv(publicKeyHex),
    ctx,
  );
  const body = (await res.json()) as { data: { flags: number } };
  assert.equal(body.data.flags, 64);
  assert.equal(pending.length, 0);
});
