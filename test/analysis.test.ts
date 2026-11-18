import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisRequest, isRecent } from "../src/analysis.ts";
import { handleRequest } from "../src/index.ts";
import { nudgeMessage } from "../src/nudge.ts";
import { makeCtx, makeEnv, makeFetch, makeKV, makeSigner, signedRequest } from "./helpers.ts";

const WEBHOOK = "https://discord.com/api/webhooks/42/secret";
const run = {
  id: "i204743831",
  name: "Run/Walk — 45/90 L2",
  type: "Run",
  start_date_local: new Date(Date.now() - 2 * 3_600_000).toISOString().slice(0, 19), // two hours ago
};
const oldRun = { ...run, id: "i1", start_date_local: "2026-10-01T12:00:00" };

/** Owner env with KV and the webhook; Intervals serves `activity`, the fire answers `fire`. */
async function setup(opts: { activity?: typeof run; fire?: boolean; kv?: Record<string, string> } = {}) {
  const { publicKeyHex, sign } = await makeSigner();
  const { kv, data } = makeKV(opts.kv);
  const env = { ...makeEnv(publicKeyHex), STATE: kv, DISCORD_WEBHOOK_URL: WEBHOOK, COACH_CHANNEL_ID: "chan-1" };
  const activity = opts.activity ?? run;
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.includes("/athlete/i123/activities")) return Response.json([activity]);
    if (call.url.includes("intervals.icu") && call.method === "GET") return Response.json(activity);
    if (call.url.includes("anthropic.com")) {
      return opts.fire === false
        ? Response.json({ error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 })
        : Response.json({ claude_code_session_url: "https://claude.ai/code/s" });
    }
    if (call.url.includes("/channels/chan-1/messages")) return Response.json([]);
    if (call.url.includes("open-meteo")) return new Response("down", { status: 503 });
    return Response.json({});
  });
  const send = async (body: unknown) => {
    const { ctx, settle } = makeCtx();
    const res = await handleRequest(await signedRequest(body, sign), env, ctx, fetchImpl);
    await settle();
    return res;
  };
  return { env, data, calls, send };
}

const fires = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("anthropic.com"));
const lastEdit = (calls: { method: string; body?: string }[]) =>
  JSON.parse(calls.filter((c) => c.method === "PATCH").at(-1)!.body!) as { content: string; components?: unknown[] };

function modal(customId: string, fields: Record<string, string[] | string>) {
  return {
    id: "submit-1",
    application_id: "app-1",
    type: 5,
    token: "modal-token",
    channel_id: "chan-1",
    member: { user: { id: "owner-1", username: "wout" } },
    message: {
      id: "nudge-1",
      content: nudgeMessage(run).content,
      timestamp: new Date().toISOString(),
      author: { id: "wh", username: "Intervals" },
      webhook_id: "wh",
      components: nudgeMessage(run).components,
    },
    data: {
      custom_id: customId,
      components: Object.entries(fields).map(([custom_id, value], i) => ({
        type: 18,
        id: i,
        component:
          typeof value === "string"
            ? { type: 4, id: 100 + i, custom_id, value }
            : { type: 3, id: 100 + i, custom_id, values: value },
      })),
    },
  };
}
const note = (text: string) => modal(`note:${run.id}`, { rpe: ["6"], notes: text });
const pain = () => modal(`pain:${run.id}`, { where: ["calf"], severity: ["3"] });

function feedbackCommand(activityId?: string) {
  return {
    id: "cmd-1",
    application_id: "app-1",
    type: 2,
    token: "cmd-token",
    channel_id: "chan-1",
    member: { user: { id: "owner-1", username: "wout" } },
    data: {
      name: "feedback",
      options: [
        { name: "feel", type: 4, value: 4 },
        { name: "notes", type: 3, value: "legs heavy" },
        ...(activityId ? [{ name: "activity", type: 3, value: activityId }] : []),
      ],
    },
  };
}

test("the note pop-up starts one analysis of that activity, with the feedback in the request", async () => {
  const { data, calls, send } = await setup();
  await send(note("legs heavy  in the last\nrun"));

  const [fire] = fires(calls);
  assert.ok(fire, "the coach was started");
  const text = JSON.parse(fire!.body!).text as string;
  assert.match(text, /From: the Worker's automated activity analysis/);
  assert.match(text, /Wout just gave feedback on this activity\.\nActivity: .*Run\/Walk — 45\/90 L2 \(Intervals id i204743831\)/);
  assert.match(text, /Just given: RPE 6\/10, note "legs heavy in the last run"\./);
  assert.match(text, /follow its "Activity analysis" section/);
  assert.ok(data.has(`analysed:${run.id}`));
  assert.ok([...data.keys()].some((k) => k.startsWith("pending:activity-analysis-")), "watched by the watchdog");

  const edit = lastEdit(calls);
  assert.match(edit.content, /📝 Feedback saved on .*\nRPE: 6\/10\n> legs heavy {2}in the last\n> run\n🧠 _Coach is analysing it/);

  // A second pop-up saves, but doesn't start the coach again.
  await send(note("one more thing"));
  assert.equal(fires(calls).length, 1);
});

test("a run that can't start clears the flag, says so and posts a System notice", async () => {
  const { data, calls, send } = await setup({ fire: false });
  await send(note("fine"));
  assert.equal(data.has(`analysed:${run.id}`), false, "the 20:35 check picks it up");
  const notice = calls.find((c) => c.url.startsWith(WEBHOOK));
  assert.match(JSON.parse(notice!.body!).content, /^⚠️ Couldn't start the activity analysis \(rate_limit_error: slow down\)/);
  assert.match(lastEdit(calls).content, /The coach couldn't start .*20:35 activity check/);
});

test("pain before the analysis only waits; after it, one follow-up", async () => {
  const before = await setup();
  await before.send(pain());
  assert.equal(fires(before.calls).length, 0);
  assert.doesNotMatch(lastEdit(before.calls).content, /🧠/);

  const after = await setup({ kv: { [`analysed:${run.id}`]: "1" } });
  await after.send(pain());
  const [fire] = fires(after.calls);
  const text = JSON.parse(fire!.body!).text as string;
  assert.match(text, /=== Automated pain follow-up \(this is the request\) ===\nWout just reported pain/);
  assert.match(text, /Just given: pain "calf 3\/10"/);
  assert.match(lastEdit(after.calls).content, /🧠 _Coach is looking at the pain report/);

  await after.send(pain());
  assert.equal(fires(after.calls).length, 1, "one follow-up per activity");
});

test("a feel tap alone doesn't start the coach", async () => {
  const { calls, send } = await setup();
  const tap = { ...note(""), type: 3, data: { custom_id: `feel:${run.id}:2`, component_type: 2 } };
  await send(tap);
  assert.ok(calls.some((c) => c.method === "PUT"), "saved");
  assert.equal(fires(calls).length, 0);
});

test("/feedback starts the analysis for a recent activity, not for an old one", async () => {
  const recent = await setup();
  const res = await recent.send(feedbackCommand());
  assert.deepEqual(await res.json(), { type: 5 });
  assert.equal(fires(recent.calls).length, 1);
  const edits = recent.calls.filter((c) => c.method === "PATCH").map((c) => JSON.parse(c.body!).content as string);
  assert.equal(edits.length, 2, "shown first, then the analysis line added");
  assert.match(edits[0]!, /^📝 Feedback saved on/);
  assert.match(edits[1]!, /\n🧠 _Coach is analysing it/);

  const old = await setup({ activity: oldRun });
  await old.send(feedbackCommand(oldRun.id));
  assert.equal(fires(old.calls).length, 0);
  assert.equal(old.calls.filter((c) => c.method === "PATCH").length, 1);
});

test("isRecent: today and yesterday in Brussels", () => {
  const now = new Date("2026-11-05T22:30:00Z"); // 23:30 Thu in Brussels
  assert.equal(isRecent({ id: "a", start_date_local: "2026-11-04T07:00:00" }, now), true);
  assert.equal(isRecent({ id: "a", start_date_local: "2026-11-03T23:00:00" }, now), false);
});

test("analysisRequest: says what was given, or nothing new", () => {
  assert.match(analysisRequest(run, {}, "activity analysis"), /Just given: nothing new\./);
  assert.match(analysisRequest(run, { feel: 1, rpe: 3 }, "activity analysis"), /Just given: feel Strong \(1\/5\), RPE 3\/10\./);
});
