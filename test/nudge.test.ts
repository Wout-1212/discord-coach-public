import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/index.ts";
import { hasFeedback, nudgeMessage, nudgeNewActivities } from "../src/nudge.ts";
import { makeCtx, makeEnv, makeFetch, makeKV, makeSigner, signedRequest } from "./helpers.ts";

const DAYTIME = new Date("2026-11-03T18:00:00Z"); // 19:00 in Brussels
const NIGHT = new Date("2026-11-03T22:30:00Z"); // 23:30 in Brussels
const WEBHOOK = "https://discord.com/api/webhooks/42/secret";

const ride = {
  id: "i205170359",
  name: "Ride — Aerobic Foundation 90m (Z2)",
  type: "VirtualRide",
  start_date_local: "2026-11-03T11:00:22",
  moving_time: 5412,
  icu_training_load: 63.6,
};
const run = { id: "i204743831", name: "Run/Walk", type: "Run", start_date_local: "2026-11-02T12:18:48" };
const logged = { ...run, id: "i1", feel: 2 };

function setup(activities: unknown[] = [run, ride, logged], messages: Record<string, unknown[]> = {}) {
  const { kv, data } = makeKV();
  const env = { ...makeEnv("00"), STATE: kv, DISCORD_WEBHOOK_URL: WEBHOOK };
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.endsWith("/messages")) return Response.json(messages[call.url.split("/").at(-2)!] ?? []);
    return call.url.includes("intervals.icu") ? Response.json(activities) : Response.json({ id: "msg" });
  });
  return { env, data, fetchImpl, calls };
}

test("an activity whose note is already in its messages isn't nudged", async () => {
  const { env, calls, fetchImpl } = setup([run, ride], { [run.id]: [{ content: "Feedback: fine" }] });
  assert.equal(await nudgeNewActivities(env, DAYTIME, fetchImpl), 1);
  const posts = calls.filter((c) => c.url.startsWith(WEBHOOK)).map((c) => JSON.parse(c.body!).content as string);
  assert.deepEqual(posts.map((p) => p.includes("Run/Walk")), [false]);
});

test("hasFeedback: feel, RPE or a Feedback: line in the description", () => {
  assert.equal(hasFeedback(run), false);
  assert.equal(hasFeedback({ ...run, icu_rpe: 5 }), true);
  assert.equal(hasFeedback({ ...run, feel: 3 }), true);
  assert.equal(hasFeedback({ ...run, description: "Zwift\n\nFeedback: fine" }), true);
  assert.equal(hasFeedback({ ...run, description: "No feedback yet" }), false);
});

test("nudgeMessage: activity, stats, five feel buttons and a note button", () => {
  const { content, components } = nudgeMessage(ride);
  assert.equal(
    content,
    "🚴 New activity: **Tue 03 Nov, 11:00 · Ride — Aerobic Foundation 90m (Z2)**\n1h30 · 64 load\n" +
      "How did it feel? Tap one, and add your RPE and a note with 📝.",
  );
  const note = (components[1] as { components: { custom_id: string }[] }).components;
  assert.equal(note[0]!.custom_id, "note:i205170359");
  const buttons = (components[0] as { components: { label: string; custom_id: string }[] }).components;
  assert.deepEqual(
    buttons.map((b) => b.label),
    ["Strong", "Good", "Normal", "Poor", "Weak"],
  );
  assert.equal(buttons[1]!.custom_id, "feel:i205170359:2");
});

test("nudges each activity without feedback once, oldest first, as Intervals", async () => {
  const { env, data, fetchImpl, calls } = setup();
  assert.equal(await nudgeNewActivities(env, DAYTIME, fetchImpl), 2);
  const posts = calls.filter((c) => c.url.startsWith(WEBHOOK));
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.url, `${WEBHOOK}?wait=true&with_components=true`);
  const first = JSON.parse(posts[0]!.body!);
  assert.equal(first.username, "Intervals");
  assert.match(first.content, /Run\/Walk/, "older activity first");
  assert.ok(first.components);
  assert.ok(data.has(`nudged:${ride.id}`));
  assert.ok(!data.has("nudged:i1"), "activity with feedback skipped");

  assert.equal(await nudgeNewActivities(env, DAYTIME, fetchImpl), 0, "not twice");
});

test("no nudges at night, or without KV / webhook", async () => {
  const night = setup();
  assert.equal(await nudgeNewActivities(night.env, NIGHT, night.fetchImpl), 0);
  assert.equal(night.calls.length, 0);

  const noKv = setup();
  assert.equal(await nudgeNewActivities({ ...noKv.env, STATE: undefined }, DAYTIME, noKv.fetchImpl), 0);
  assert.equal(await nudgeNewActivities({ ...noKv.env, DISCORD_WEBHOOK_URL: "" }, DAYTIME, noKv.fetchImpl), 0);
  assert.equal(noKv.calls.length, 0);
});

function feelClick(userId: string, customId: string) {
  return {
    id: "click-1",
    application_id: "app-1",
    type: 3,
    token: "click-token",
    channel_id: "chan-1",
    member: { user: { id: userId, username: "wout" } },
    data: { custom_id: customId, component_type: 2 },
    message: {
      id: "nudge-1",
      content: nudgeMessage(ride).content,
      timestamp: "2026-11-03T12:00:00Z",
      author: { id: "wh", username: "Intervals" },
      webhook_id: "wh",
    },
  };
}

test("tapping a feel button saves it on the activity and replaces the buttons", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) => (call.method === "GET" ? Response.json(ride) : Response.json({})));
  const res = await handleRequest(
    await signedRequest(feelClick("owner-1", `feel:${ride.id}:2`), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  assert.deepEqual(await res.json(), { type: 6 });
  await settle();

  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put?.url.endsWith(`/activity/${ride.id}`));
  assert.deepEqual(JSON.parse(put!.body!), { feel: 2 });

  const edit = calls.find((c) => c.method === "PATCH");
  assert.ok(edit?.url.endsWith("/webhooks/app-1/click-token/messages/@original"));
  const body = JSON.parse(edit!.body!);
  assert.deepEqual(body.components, []);
  assert.match(body.content, /^🚴 New activity: .*\n1h30 · 64 load\n📝 Feel saved: \*\*Good\*\* \(2\/5\)/);
  assert.ok(!body.content.includes("How did it feel?"));
});

test("a feel tap keeps the note button", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) => (call.method === "GET" ? Response.json(ride) : Response.json({})));
  const click = feelClick("owner-1", `feel:${ride.id}:2`);
  const message = { ...click.message, components: nudgeMessage(ride).components };
  await handleRequest(await signedRequest({ ...click, message }, sign), makeEnv(publicKeyHex), ctx, fetchImpl);
  await settle();
  const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
  assert.equal(body.components.length, 1);
  assert.equal(body.components[0].components[0].custom_id, `note:${ride.id}`);
  assert.match(body.content, /Add your RPE and a note with 📝: the coach analyses it once you send it\.$/);
});

test("the note button opens a pop-up with optional RPE and note fields", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const res = await handleRequest(
    await signedRequest(feelClick("owner-1", `note:${ride.id}`), sign),
    makeEnv(publicKeyHex),
    ctx,
  );
  const body = (await res.json()) as {
    type: number;
    data: {
      custom_id: string;
      components: { type: number; component: { custom_id: string; required: boolean; options?: unknown[] } }[];
    };
  };
  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, `note:${ride.id}`);
  const [rpe, notes] = body.data.components;
  assert.equal(rpe!.type, 18);
  assert.equal(rpe!.component.custom_id, "rpe");
  assert.equal(rpe!.component.options?.length, 10);
  assert.equal(rpe!.component.required, false);
  assert.equal(notes!.component.custom_id, "notes");
  assert.equal(notes!.component.required, false);
  assert.equal(pending.length, 0);
});

function noteSubmit(userId: string, rpe: string[], notes: string) {
  const click = feelClick(userId, `note:${ride.id}`);
  return {
    ...click,
    type: 5,
    message: { ...click.message, components: nudgeMessage(ride).components },
    data: {
      custom_id: `note:${ride.id}`,
      components: [
        { type: 18, id: 1, component: { type: 3, id: 2, custom_id: "rpe", values: rpe } },
        { type: 18, id: 3, component: { type: 4, id: 4, custom_id: "notes", value: notes } },
      ],
    },
  };
}

test("sending the pop-up saves RPE and note, and keeps the feel buttons", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) => (call.method === "GET" ? Response.json(ride) : Response.json({})));
  const res = await handleRequest(
    await signedRequest(noteSubmit("owner-1", ["7"], "  legs heavy  "), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  assert.deepEqual(await res.json(), { type: 6 });
  await settle();

  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put?.url.endsWith(`/activity/${ride.id}`));
  assert.deepEqual(JSON.parse(put!.body!), { icu_rpe: 7 });
  const message = calls.find((c) => c.url.endsWith("/messages"));
  assert.deepEqual(JSON.parse(message!.body!), { content: "Feedback: legs heavy" });

  const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
  assert.match(body.content, /📝 Feedback saved on/);
  assert.match(body.content, /RPE: 7\/10\n> legs heavy$/);
  assert.equal(body.components.length, 1, "only the feel row is left");
  assert.match(body.components[0].components[0].custom_id, /^feel:/);
});

test("an empty pop-up saves nothing; someone else's is refused", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const env = makeEnv(publicKeyHex);
  const empty = await handleRequest(await signedRequest(noteSubmit("owner-1", [], "   "), sign), env, ctx);
  assert.match(((await empty.json()) as { data: { content: string } }).data.content, /Nothing saved/);
  const other = await handleRequest(await signedRequest(noteSubmit("intruder", ["5"], "hi"), sign), env, ctx);
  assert.match(((await other.json()) as { data: { content: string } }).data.content, /private/);
  assert.equal(pending.length, 0);
});

test("a feel tap by someone else is refused", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const res = await handleRequest(
    await signedRequest(feelClick("intruder", `feel:${ride.id}:5`), sign),
    makeEnv(publicKeyHex),
    ctx,
  );
  const body = (await res.json()) as { data: { content: string; flags: number } };
  assert.equal(body.data.flags, 64);
  assert.equal(pending.length, 0);
});

function painSubmit(userId: string, fields: Record<string, string>) {
  const click = feelClick(userId, `pain:${run.id}`);
  return {
    ...click,
    type: 5,
    message: { ...click.message, components: nudgeMessage(run).components },
    data: {
      custom_id: `pain:${run.id}`,
      components: Object.entries(fields).map(([custom_id, value], i) => ({
        type: 18,
        id: i,
        component: { type: 3, id: 100 + i, custom_id, values: [value] },
      })),
    },
  };
}

test("only runs get a pain button, on its own row", () => {
  const rows = nudgeMessage(run).components as { components: { label: string; custom_id: string }[] }[];
  assert.equal(rows.length, 3);
  assert.equal(rows[2]!.components[0]!.label, "🦵 Pain");
  assert.equal(rows[2]!.components[0]!.custom_id, `pain:${run.id}`);
  assert.equal(nudgeMessage(ride).components.length, 2);
  assert.ok(!nudgeMessage(run).content.toLowerCase().includes("pain"), "nothing asks about pain");
});

test("hasFeedback: a pain report counts", () => {
  assert.equal(hasFeedback({ ...run, description: "Pain: calf 3/10" }), true);
});

test("the pain button opens a pop-up with five fields, two of them required", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const res = await handleRequest(
    await signedRequest(feelClick("owner-1", `pain:${run.id}`), sign),
    makeEnv(publicKeyHex),
    ctx,
  );
  const body = (await res.json()) as {
    type: number;
    data: { custom_id: string; components: { component: { custom_id: string; required: boolean } }[] };
  };
  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, `pain:${run.id}`);
  assert.deepEqual(
    body.data.components.map((c) => [c.component.custom_id, c.component.required]),
    [["where", true], ["severity", true], ["when", false], ["trend", false], ["effect", false]],
  );
  assert.equal(pending.length, 0);
});

test("sending the pain pop-up saves a Pain line and leaves the other buttons", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const withDescription = { ...run, description: "Run/Walk 45/90" };
  const { fetchImpl, calls } = makeFetch((call) =>
    call.method === "GET" ? Response.json(withDescription) : Response.json({}),
  );
  const fields = { where: "calf", severity: "3", when: "during", trend: "same", effect: "changed how I ran" };
  const res = await handleRequest(
    await signedRequest(painSubmit("owner-1", fields), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  assert.deepEqual(await res.json(), { type: 6 });
  await settle();

  assert.equal(calls.some((c) => c.method === "PUT"), false, "the description is never touched");
  const post = calls.find((c) => c.method === "POST" && c.url.includes("intervals.icu"));
  assert.ok(post?.url.endsWith(`/activity/${run.id}/messages`));
  assert.deepEqual(JSON.parse(post!.body!), { content: "Pain: calf 3/10, during, same, changed how I ran" });

  const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
  assert.match(body.content, /🦵 Pain: calf 3\/10, during, same, changed how I ran$/);
  assert.equal(body.components.length, 2, "feel and note rows are left");
});

test("the optional pain fields can stay empty", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) => (call.method === "GET" ? Response.json(run) : Response.json({})));
  await handleRequest(
    await signedRequest(painSubmit("owner-1", { where: "knee", severity: "2" }), sign),
    makeEnv(publicKeyHex),
    ctx,
    fetchImpl,
  );
  await settle();
  assert.deepEqual(JSON.parse(calls.find((c) => c.url.endsWith("/messages"))!.body!), { content: "Pain: knee 2/10" });
});

test("a pain pop-up without place and severity saves nothing; someone else's is refused", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const env = makeEnv(publicKeyHex);
  const empty = await handleRequest(await signedRequest(painSubmit("owner-1", { where: "calf" }), sign), env, ctx);
  assert.match(((await empty.json()) as { data: { content: string } }).data.content, /Nothing saved/);
  const other = await handleRequest(
    await signedRequest(painSubmit("intruder", { where: "calf", severity: "9" }), sign),
    env,
    ctx,
  );
  assert.match(((await other.json()) as { data: { content: string } }).data.content, /private/);
  assert.equal(pending.length, 0);
});

test("a feel tap only offers a note while the note button is still there", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) => (call.method === "GET" ? Response.json(run) : Response.json({})));
  const click = feelClick("owner-1", `feel:${run.id}:2`);
  const [feelRow, , painRow] = nudgeMessage(run).components;
  const message = { ...click.message, components: [feelRow, painRow] }; // the note was saved earlier
  await handleRequest(await signedRequest({ ...click, message }, sign), makeEnv(publicKeyHex), ctx, fetchImpl);
  await settle();
  const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
  assert.equal(body.components.length, 1, "the pain row stays");
  assert.doesNotMatch(body.content, /Add your RPE/);
});
