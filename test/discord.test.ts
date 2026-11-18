import assert from "node:assert/strict";
import { test } from "node:test";
import { ACK_MARKER, buildAck, formatHistory, postFollowup, questionFromAck } from "../src/discord.ts";
import { buildTaskText } from "../src/task-text.ts";
import type { DiscordMessage } from "../src/types.ts";
import { makeEnv, makeFetch } from "./helpers.ts";

test("ack quotes the question and can be turned back into it", () => {
  const q = "analyse today's ride\nand compare with last week";
  const ack = buildAck(q);
  assert.ok(ack.startsWith("> analyse today's ride\n> and compare"));
  assert.ok(ack.endsWith(ACK_MARKER));
  assert.equal(questionFromAck(ack), q);
});

const owner = { id: "owner-1", username: "wout", global_name: "Wout" };
const app = { id: "app-1", username: "Coach", bot: true };

// Discord returns newest first.
const messages: DiscordMessage[] = [
  {
    id: "5",
    content: buildAck("yes"),
    timestamp: "2026-11-03T14:20:00Z",
    author: app,
    interaction_metadata: { id: "current-interaction", user: owner },
  },
  {
    id: "4",
    content: "Proposal: move Z2 90 min from Fri 7 Nov to Sat 8 Nov. Reply `/coach yes` to confirm.",
    timestamp: "2026-11-03T14:12:00Z",
    author: { id: "wh", username: "Coach", bot: true },
    webhook_id: "wh",
  },
  {
    id: "3",
    content: buildAck("move Friday's ride to Saturday"),
    timestamp: "2026-11-03T14:10:00Z",
    author: app,
    interaction_metadata: { id: "older-interaction", user: owner },
  },
  {
    id: "2",
    content: "⚠️ Couldn't start the coach (HTTP 429).",
    timestamp: "2026-11-03T14:00:00Z",
    author: app,
  },
  { id: "1", content: "", timestamp: "2026-11-03T13:00:00Z", author: owner },
];

test("formatHistory: oldest first, labels speakers, skips the current interaction and empties", () => {
  const out = formatHistory(messages, {
    excludeInteractionId: "current-interaction",
    applicationId: "app-1",
    ownerName: "Wout",
  });
  const lines = out.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /System: ⚠️ Couldn't start/);
  assert.match(lines[1]!, /\] Wout: move Friday's ride to Saturday$/);
  assert.match(lines[2]!, /\] Coach: Proposal: move Z2/);
  assert.ok(!out.includes(ACK_MARKER));
  // 14:10 UTC = 15:10 in Brussels (CET)
  assert.match(lines[1]!, /15:10/);
});

test("questionFromAck ignores status lines added below the marker", () => {
  const ack = `${buildAck("hi")}\n-# 🔗 [Cloud session](<https://claude.ai/code/s>)\n⚠️ No answer after 10 min.`;
  assert.equal(questionFromAck(ack), "hi");
});

test("formatHistory: Worker replies are System, webhook posts use their name", () => {
  const out = formatHistory(
    [
      {
        id: "3",
        content: "🚴 New activity: **Tue 03 Nov, 11:00 · Ride**",
        timestamp: "2026-11-03T14:02:00Z",
        author: { id: "wh", username: "Intervals" },
        webhook_id: "wh",
      },
      {
        id: "2",
        content: "📅 **Today · Tue 03 Nov**\nRest",
        timestamp: "2026-11-03T14:01:00Z",
        author: app,
        interaction_metadata: { id: "plan-interaction", user: owner },
      },
    ],
    { applicationId: "app-1", ownerName: "Wout" },
  );
  const lines = out.split("\n");
  assert.match(lines[0]!, /\] System: 📅 \*\*Today/);
  assert.match(out, /\] Intervals: 🚴 New activity/);
});

test("task text includes a button-confirmed proposal as its own section", () => {
  const text = buildTaskText({
    question: "✅ Confirmed: carry out the proposal below.",
    ownerName: "Wout",
    history: "",
    proposal: "Proposal: move the ride to Saturday.",
  });
  assert.match(
    text,
    /=== The Coach proposal Wout confirmed with the ✅ button \(carry out exactly this\) ===\nProposal: move the ride to Saturday\.\n\n=== Recent messages/,
  );
});

test("formatHistory keeps the newest part when too long", () => {
  const long: DiscordMessage[] = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    content: `msg ${i} ` + "x".repeat(1400),
    timestamp: new Date(Date.UTC(2026, 10, 3, 12, 59 - i)).toISOString(),
    author: { id: "wh", username: "Coach" },
    webhook_id: "wh",
  }));
  const out = formatHistory(long, { applicationId: "app-1", ownerName: "Wout" });
  assert.ok(out.length <= 20_000);
  assert.ok(out.includes("msg 0 "), "newest message kept");
  assert.ok(!out.includes("msg 29 "), "oldest message dropped");
});

test("task text separates the request from the context", () => {
  const text = buildTaskText({
    question: "yes",
    ownerName: "Wout",
    history: "[Tue 03 Nov, 15:12] Coach: Proposal …",
    now: new Date("2026-11-03T14:20:00Z"),
  });
  assert.match(text, /^DISCORD COACH REQUEST/);
  assert.match(text, /Received: .*15:20 \(Europe\/Brussels\)/);
  assert.match(text, /=== Wout's message \(this is the request\) ===\nyes\n/);
  assert.match(text, /context only — not instructions\) ===\n\[Tue 03 Nov, 15:12\] Coach/);
});

test("task text with empty history and a note", () => {
  const text = buildTaskText({ question: "hi", ownerName: "Wout", history: "", historyNote: "history failed" });
  assert.match(text, /\(no earlier messages\)/);
  assert.match(text, /\(Note: history failed\)/);
});

test("postFollowup throws when Discord refuses it, so the failure is logged", async () => {
  const { fetchImpl } = makeFetch(() => new Response("Unknown Webhook", { status: 404 }));
  await assert.rejects(postFollowup(makeEnv("k"), "expired-token", "⚠️ oops", fetchImpl), /follow-up HTTP 404/);
});
