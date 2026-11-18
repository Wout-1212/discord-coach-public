import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/index.ts";
import { CANCELLED_LINE, CONFIRMED_LINE } from "../src/proposal.ts";
import { makeCtx, makeEnv, makeFetch, makeKV, makeSigner, signedRequest } from "./helpers.ts";

const PROPOSAL = "Proposal: move Z2 90 min from Fri 7 Nov to Sat 8 Nov.\nTap ✅ Confirm, or reply `/coach yes`.";

function click(customId: string, ageMs = 3_600_000, content = PROPOSAL) {
  return {
    id: "click-7",
    application_id: "app-1",
    type: 3,
    token: "click-token",
    channel_id: "chan-1",
    member: { user: { id: "owner-1", username: "wout", global_name: "Woootie" } },
    data: { custom_id: customId, component_type: 2 },
    message: {
      id: "proposal-1",
      content,
      timestamp: new Date(Date.now() - ageMs).toISOString(),
      author: { id: "wh", username: "Coach" },
      webhook_id: "wh",
    },
  };
}

async function setup(fire: () => Response = () => Response.json({ claude_code_session_url: "https://claude.ai/code/s" })) {
  const { publicKeyHex, sign } = await makeSigner();
  const { kv, data } = makeKV();
  const env = { ...makeEnv(publicKeyHex), STATE: kv };
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.includes("anthropic.com")) return fire();
    if (call.url.includes("/channels/")) return Response.json([]);
    return Response.json({});
  });
  async function send(body: unknown) {
    const { ctx, settle } = makeCtx();
    const res = await handleRequest(await signedRequest(body, sign), env, ctx, fetchImpl);
    const json = (await res.json()) as { type: number; data?: { content: string; components: unknown[] } };
    await settle();
    return json;
  }
  return { send, calls, data };
}

test("✅ Confirm: buttons go, and the task runs with exactly that proposal", async () => {
  const { send, calls, data } = await setup();
  const res = await send(click("proposal:confirm"));
  assert.equal(res.type, 7);
  assert.equal(res.data!.content, `${CONFIRMED_LINE}\n\n${PROPOSAL}`);
  assert.deepEqual(res.data!.components, []);

  const fire = calls.find((c) => c.url.includes("anthropic.com"));
  const text = JSON.parse(fire!.body!).text as string;
  assert.match(text, /=== Wout's message \(this is the request\) ===\n✅ Confirmed: carry out the proposal below\./);
  assert.ok(text.includes(`confirmed with the ✅ button (carry out exactly this) ===\n${PROPOSAL}\n`));
  assert.ok(data.has("clicked:proposal-1"));
  assert.ok(data.has("pending:click-7"), "watchdog tracks the run");

  const edit = calls.find((c) => c.method === "PATCH");
  assert.ok(JSON.parse(edit!.body!).content.endsWith("\n-# 🔗 [Cloud session](<https://claude.ai/code/s>)"));
});

test("a long proposal keeps its ✅ line and session link; the coach still gets all of it", async () => {
  const { send, calls } = await setup();
  const long = `Proposal: ${"x".repeat(1_880)}`;
  const res = await send(click("proposal:confirm", 3_600_000, long));
  assert.ok(res.data!.content.startsWith(CONFIRMED_LINE));

  const edited = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).content as string;
  assert.ok(edited.startsWith(CONFIRMED_LINE));
  assert.ok(edited.endsWith("[Cloud session](<https://claude.ai/code/s>)"));
  assert.ok(edited.length < 1_800, "room for a watchdog warning");

  const fire = calls.find((c) => c.url.includes("anthropic.com"));
  assert.ok((JSON.parse(fire!.body!).text as string).includes(long));
});

test("a second tap does nothing", async () => {
  const { send, calls } = await setup();
  await send(click("proposal:confirm"));
  const fires = () => calls.filter((c) => c.url.includes("anthropic.com")).length;
  assert.equal(fires(), 1);
  const again = await send(click("proposal:confirm"));
  assert.equal(again.type, 7);
  assert.equal(again.data!.content, PROPOSAL);
  assert.equal(fires(), 1);
});

test("Cancel marks it cancelled without starting the coach", async () => {
  const { send, calls } = await setup();
  const res = await send(click("proposal:cancel"));
  assert.equal(res.data!.content, `${CANCELLED_LINE}\n\n${PROPOSAL}`);
  assert.deepEqual(res.data!.components, []);
  assert.equal(calls.length, 0);
});

test("a proposal older than 24 h expires", async () => {
  const { send, calls } = await setup();
  const res = await send(click("proposal:confirm", 25 * 3_600_000));
  assert.match(res.data!.content, /⌛ Expired/);
  assert.equal(calls.length, 0);
});

test("if the task can't start, the buttons come back and the error is posted", async () => {
  const { send, calls, data } = await setup(
    () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), { status: 429 }),
  );
  await send(click("proposal:confirm"));
  assert.ok(!data.has("clicked:proposal-1"), "lock released for a retry");
  const followup = calls.find((c) => c.method === "POST" && c.url.endsWith("/webhooks/app-1/click-token"));
  assert.match(JSON.parse(followup!.body!).content, /Couldn't start the coach/);
  const restore = calls.find((c) => c.method === "PATCH");
  const body = JSON.parse(restore!.body!);
  assert.equal(body.content, PROPOSAL);
  assert.equal(body.components[0].components[0].custom_id, "proposal:confirm");
});
