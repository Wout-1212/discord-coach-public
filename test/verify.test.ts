import assert from "node:assert/strict";
import { test } from "node:test";
import { hexToBytes, verifyDiscordRequest } from "../src/verify.ts";
import { makeSigner } from "./helpers.ts";

test("accepts a correctly signed request", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const body = JSON.stringify({ type: 1 });
  const sig = await sign("1730000000", body);
  assert.equal(await verifyDiscordRequest(body, sig, "1730000000", publicKeyHex), true);
});

test("rejects a tampered body, wrong timestamp, missing headers or garbage", async () => {
  const { publicKeyHex, sign } = await makeSigner();
  const body = JSON.stringify({ type: 1 });
  const sig = await sign("1730000000", body);
  assert.equal(await verifyDiscordRequest(body + " ", sig, "1730000000", publicKeyHex), false);
  assert.equal(await verifyDiscordRequest(body, sig, "1730000001", publicKeyHex), false);
  assert.equal(await verifyDiscordRequest(body, null, "1730000000", publicKeyHex), false);
  assert.equal(await verifyDiscordRequest(body, sig, null, publicKeyHex), false);
  assert.equal(await verifyDiscordRequest(body, "zz-not-hex", "1730000000", publicKeyHex), false);
  assert.equal(await verifyDiscordRequest(body, sig, "1730000000", "abcd"), false);
});

test("rejects a signature from a different key", async () => {
  const a = await makeSigner();
  const b = await makeSigner();
  const body = "{}";
  const sig = await b.sign("1", body);
  assert.equal(await verifyDiscordRequest(body, sig, "1", a.publicKeyHex), false);
});

test("hexToBytes", () => {
  assert.deepEqual([...hexToBytes("00ff10")], [0, 255, 16]);
  assert.throws(() => hexToBytes("abc"));
  assert.throws(() => hexToBytes("zz"));
});
