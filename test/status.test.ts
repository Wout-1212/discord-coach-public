import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/index.ts";
import { formatStatus, showStatus } from "../src/status.ts";
import { makeCtx, makeEnv, makeFetch, makeSigner, signedRequest } from "./helpers.ts";

const NOW = new Date("2026-11-04T18:00:00Z"); // Wed 04 Nov, 19:00 in Brussels
const WEATHER = [
  "Outdoor rule: …",
  "Outdoor rides: …",
  "- Wed 04 Nov: 🏠 indoor: no daylight left",
  "- Thu 05 Nov: ✅ outdoor 12:00–17:00 (5 h)",
].join("\n");

const days = [
  { id: "2026-11-02", ctl: 29, atl: 25, hrv: 80, restingHR: 46 },
  { id: "2026-11-03", ctl: 29.4, atl: 24, hrv: 76, restingHR: 48 },
  { id: "2026-11-04", ctl: 27.98, atl: 22.9, hrv: 77, restingHR: 48, sleepSecs: 30360, sleepScore: 89 },
];

test("formatStatus: load, last night vs the days before, and the forecast lines only", () => {
  assert.equal(
    formatStatus(days, WEATHER, NOW),
    [
      "📊 **Status · Wed 04 Nov**",
      "**Load:** fitness (CTL) 28 · fatigue (ATL) 23 · form +5",
      "**Last night:** sleep 8h26 (score 89) · HRV 77 (7-day avg 78) · resting HR 48 (7-day avg 47)",
      "",
      "**Ride weather**",
      "- Wed 04 Nov: 🏠 indoor: no daylight left",
      "- Thu 05 Nov: ✅ outdoor 12:00–17:00 (5 h)",
      "-# Calendar: `/plan`. Advice: `/coach`",
    ].join("\n"),
  );
});

test("formatStatus: says so when Garmin hasn't synced or the forecast is down", () => {
  const synced = days.slice(0, 2);
  const text = formatStatus(synced, "(forecast unavailable: Open-Meteo HTTP 500)", NOW);
  assert.match(text, /\*\*Load:\*\* fitness \(CTL\) 29 · fatigue \(ATL\) 24 · form \+5/);
  assert.match(text, /\*\*Last night:\*\* no Garmin data yet/);
  assert.match(text, /Forecast unavailable\./);
  assert.match(formatStatus([], WEATHER, NOW), /\*\*Load:\*\* no data/);
});

test("showStatus reads the last 7 days and explains a rejected key", async () => {
  const { fetchImpl, calls } = makeFetch((call) =>
    call.url.includes("intervals.icu") ? Response.json(days) : new Response("down", { status: 503 }),
  );
  assert.match(await showStatus(makeEnv("00"), NOW, fetchImpl), /form \+5/);
  assert.ok(calls.some((c) => c.url.endsWith("/athlete/i123/wellness?oldest=2026-10-28&newest=2026-11-04")));

  const rejected = makeFetch((call) =>
    call.url.includes("intervals.icu") ? new Response("no", { status: 401 }) : new Response("down", { status: 503 }),
  );
  assert.match(await showStatus(makeEnv("00"), NOW, rejected.fetchImpl), /rejected the API key/);
});

function statusInteraction(userId: string) {
  return {
    id: "interaction-1",
    application_id: "app-1",
    type: 2,
    token: "status-token",
    channel_id: "chan-1",
    member: { user: { id: userId, username: "wout" } },
    data: { name: "status" },
  };
}

test("/status answers through the deferred reply, without starting the coach", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, settle } = makeCtx();
  const { fetchImpl, calls } = makeFetch((call) =>
    call.url.includes("intervals.icu") ? Response.json(days) : Response.json({}),
  );
  const res = await handleRequest(await signedRequest(statusInteraction("owner-1"), sign), makeEnv(publicKeyHex), ctx, fetchImpl);
  assert.deepEqual(await res.json(), { type: 5 });
  await settle();
  const edit = calls.find((c) => c.method === "PATCH");
  assert.ok(edit?.url.endsWith("/webhooks/app-1/status-token/messages/@original"));
  assert.match(JSON.parse(edit!.body!).content, /^📊 \*\*Status/);
  assert.ok(!calls.some((c) => c.url.includes("anthropic.com")));
});

test("/status is private", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const { ctx, pending } = makeCtx();
  const res = await handleRequest(await signedRequest(statusInteraction("intruder"), sign), makeEnv(publicKeyHex), ctx);
  assert.match(((await res.json()) as { data: { content: string } }).data.content, /private/);
  assert.equal(pending.length, 0);
});
