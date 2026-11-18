import assert from "node:assert/strict";
import { test } from "node:test";
import { activityChoices, activityLabel, saveFeedback } from "../src/feedback.ts";
import { handleRequest } from "../src/index.ts";
import { makeCtx, makeEnv, makeFetch, makeSigner } from "./helpers.ts";

const NOW = new Date("2026-11-03T18:00:00Z");
const ride = {
  id: "i205170359",
  name: "Ride — Aerobic Foundation 90m (Z2)",
  type: "VirtualRide",
  start_date_local: "2026-11-03T11:00:22",
  description: "Zwift workout",
};
const run = { id: "i204743831", name: "Run/Walk — 45/90 L2", type: "Run", start_date_local: "2026-11-02T12:18:48" };

/** Fake Intervals: activity list (oldest first, to check we sort), single activity, PUT. */
function intervalsFetch() {
  return makeFetch((call) => {
    if (call.url.includes("/athlete/i123/activities")) return Response.json([run, ride]);
    if (call.method === "GET" && call.url.endsWith(`/activity/${run.id}`)) return Response.json(run);
    if (call.method === "PUT" || call.method === "POST") return Response.json({});
    if (call.method === "PATCH") return Response.json({});
    return new Response("not found", { status: 404 });
  });
}

test("activityLabel shows the local start time and name", () => {
  assert.equal(activityLabel(ride), "Tue 03 Nov, 11:00 · Ride — Aerobic Foundation 90m (Z2)");
  assert.equal(activityLabel({ ...ride, name: "x".repeat(150) }).length, 100);
});

test("activityChoices: newest first, filtered by typed text, Basic auth", async () => {
  const { fetchImpl, calls } = intervalsFetch();
  const env = makeEnv("00");
  assert.deepEqual(
    (await activityChoices(env, "", NOW, fetchImpl)).map((c) => c.value),
    [ride.id, run.id],
  );
  assert.deepEqual(
    (await activityChoices(env, "run", NOW, fetchImpl)).map((c) => c.value),
    [run.id],
  );
  assert.ok(calls[0]?.url.includes("oldest=2026-10-27&newest=2026-11-04"));
  assert.equal(calls[0]?.headers.authorization, `Basic ${btoa("API_KEY:icu-key")}`);
});

test("saveFeedback defaults to the most recent activity; the note is a message, never the description", async () => {
  const { fetchImpl, calls } = intervalsFetch();
  const message = await saveFeedback(
    makeEnv("00"),
    { feel: 2, rpe: 6, notes: "legs heavy first 20 min" },
    NOW,
    fetchImpl,
  );
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put?.url.endsWith(`/activity/${ride.id}`));
  assert.deepEqual(JSON.parse(put?.body ?? "{}"), { feel: 2, icu_rpe: 6 }, "no description: it goes to Strava");
  const post = calls.find((c) => c.method === "POST");
  assert.ok(post?.url.endsWith(`/activity/${ride.id}/messages`));
  assert.deepEqual(JSON.parse(post!.body!), { content: "Feedback: legs heavy first 20 min" });
  assert.match(message, /Feedback saved on \*\*Tue 03 Nov, 11:00 · Ride/);
  assert.match(message, /Feel: Good \(2\/5\) · RPE: 6\/10/);
  assert.match(message, /> legs heavy first 20 min/);
});

test("saveFeedback on a picked activity only sends the fields given", async () => {
  const { fetchImpl, calls } = intervalsFetch();
  await saveFeedback(makeEnv("00"), { activityId: run.id, rpe: 4 }, NOW, fetchImpl);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put?.url.endsWith(`/activity/${run.id}`));
  assert.deepEqual(JSON.parse(put?.body ?? "{}"), { icu_rpe: 4 });
});

test("saveFeedback explains problems instead of throwing", async () => {
  const typed = await saveFeedback(makeEnv("00"), { activityId: "my ride", rpe: 4 }, NOW, makeFetch(() => Response.json({})).fetchImpl);
  assert.match(typed, /Pick an activity from the list/);

  const badKey = makeFetch(() => new Response("unauthorized", { status: 401 }));
  assert.match(await saveFeedback(makeEnv("00"), { rpe: 4 }, NOW, badKey.fetchImpl), /INTERVALS_API_KEY/);

  const empty = makeFetch(() => Response.json([]));
  assert.match(await saveFeedback(makeEnv("00"), { rpe: 4 }, NOW, empty.fetchImpl), /No activities/);
});

async function signed(body: unknown) {
  const { publicKeyHex, sign } = await makeSigner();
  const raw = JSON.stringify(body);
  const ts = "1730000000";
  const request = new Request("https://x/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": await sign(ts, raw), "X-Signature-Timestamp": ts },
    body: raw,
  });
  return { request, env: makeEnv(publicKeyHex) };
}

function feedbackInteraction(type: number, options: unknown[], userId = "owner-1") {
  return {
    id: "interaction-f",
    application_id: "app-1",
    type,
    token: "tok-f",
    channel_id: "chan-1",
    member: { user: { id: userId, username: "wout" } },
    data: { name: "feedback", options },
  };
}

test("/feedback: deferred reply, then saved and the placeholder edited", async () => {
  const { request, env } = await signed(feedbackInteraction(2, [{ name: "rpe", type: 4, value: 5 }]));
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = intervalsFetch();
  const res = await handleRequest(request, env, ctx, fetchImpl);
  assert.deepEqual(await res.json(), { type: 5 });
  await settle();
  const edit = calls.find((c) => c.method === "PATCH");
  assert.ok(edit?.url.endsWith("/webhooks/app-1/tok-f/messages/@original"));
  assert.match(JSON.parse(edit?.body ?? "{}").content, /Feedback saved .* Ride/);
});

test("/feedback without feel, rpe or notes is refused privately", async () => {
  const { request, env } = await signed(feedbackInteraction(2, []));
  const { ctx, pending } = makeCtx();
  const body = (await (await handleRequest(request, env, ctx)).json()) as { data: { flags: number } };
  assert.equal(body.data.flags, 64);
  assert.equal(pending.length, 0);
});

test("autocomplete: owner gets activities, anyone else gets nothing", async () => {
  const typing = [{ name: "activity", type: 3, value: "ride", focused: true }];
  const owner = await signed(feedbackInteraction(4, typing));
  const { fetchImpl } = intervalsFetch();
  const ownerRes = (await (await handleRequest(owner.request, owner.env, makeCtx().ctx, fetchImpl)).json()) as {
    type: number;
    data: { choices: { value: string }[] };
  };
  assert.equal(ownerRes.type, 8);
  assert.deepEqual(ownerRes.data.choices.map((c) => c.value), [ride.id]);

  const other = await signed(feedbackInteraction(4, typing, "intruder"));
  const spy = makeFetch(() => Response.json([ride]));
  const otherRes = (await (await handleRequest(other.request, other.env, makeCtx().ctx, spy.fetchImpl)).json()) as {
    data: { choices: unknown[] };
  };
  assert.deepEqual(otherRes.data.choices, []);
  assert.equal(spy.calls.length, 0);
});
