import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Runs the real cloud/discord-post against a fake webhook. Every coach reply goes through
 * this script, so it's tested end to end. Needs python3: skipped where it's missing, runs in CI.
 */

const SCRIPT = new URL("../cloud/discord-post", import.meta.url);
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const needsPython = { skip: hasPython ? false : "python3 is not installed" };

interface Received {
  contentType: string;
  url: string;
  body: Buffer;
}

async function fakeWebhook(answer: (req: Received) => number = () => 200) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry = { contentType: req.headers["content-type"] ?? "", url: req.url ?? "", body: Buffer.concat(chunks) };
      received.push(entry);
      res.statusCode = answer(entry);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
  return { url, received, close: () => new Promise((resolve) => server.close(resolve)) };
}

function run(url: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("python3", [SCRIPT.pathname, ...args], { env: { ...process.env, DISCORD_WEBHOOK_URL: url } }, (err, out, stderr) =>
      resolve({ code: err ? Number(err.code ?? 1) : 0, output: `${out}${stderr}` }),
    );
  });
}

function tempFile(name: string, content: string | Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), "discord-post-")), name);
  writeFileSync(path, content);
  return path;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x0d, 0x0a]);

/** The parts of a multipart body, as { headers, data }. */
function parts(req: Received) {
  const boundary = /boundary=(\S+)/.exec(req.contentType)?.[1];
  assert.ok(boundary, "multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const found: { headers: string; data: Buffer }[] = [];
  let start = req.body.indexOf(delimiter);
  while (start !== -1) {
    const next = req.body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = req.body.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    found.push({ headers: part.subarray(0, split).toString(), data: part.subarray(split + 4) });
    start = next;
  }
  return found;
}

test("plain text is still sent as JSON", needsPython, async () => {
  const hook = await fakeWebhook();
  const { code } = await run(hook.url, [tempFile("reply.md", "Ride looks good.")]);
  await hook.close();
  assert.equal(code, 0);
  assert.equal(hook.received.length, 1);
  assert.equal(hook.received[0]!.contentType, "application/json");
  assert.match(hook.received[0]!.url, /wait=true&with_components=true/);
  const payload = JSON.parse(hook.received[0]!.body.toString());
  assert.equal(payload.content, "Ride looks good.");
  assert.equal(payload.username, "Coach");
  assert.equal(payload.components, undefined);
});

test("--file sends the text and the exact bytes of the file", needsPython, async () => {
  const hook = await fakeWebhook();
  const { code, output } = await run(hook.url, ["--file", tempFile("chart.png", PNG), tempFile("reply.md", "CTL chart")]);
  await hook.close();
  assert.equal(code, 0, output);
  assert.match(output, /with 1 file\(s\)/);
  const [json, file] = parts(hook.received[0]!);
  assert.match(json!.headers, /name="payload_json"/);
  assert.equal(JSON.parse(json!.data.toString()).content, "CTL chart");
  assert.match(file!.headers, /name="files\[0\]"; filename="chart.png"/);
  assert.match(file!.headers, /Content-Type: image\/png/);
  assert.deepEqual(file!.data, PNG);
});

test("--file works with --confirm and in any argument order", needsPython, async () => {
  const hook = await fakeWebhook();
  const reply = tempFile("reply.md", "Proposal");
  const { code } = await run(hook.url, [reply, "--file", tempFile("a.md", "report"), "--confirm", "--file", tempFile("b.png", PNG)]);
  await hook.close();
  assert.equal(code, 0);
  const [json, first, second] = parts(hook.received[0]!);
  assert.equal(JSON.parse(json!.data.toString()).components[0].components[0].custom_id, "proposal:confirm");
  assert.match(first!.headers, /filename="a.md"/);
  assert.match(second!.headers, /name="files\[1\]"; filename="b.png"/);
});

test("a long reply only carries the file on its last part", needsPython, async () => {
  const hook = await fakeWebhook();
  const text = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`;
  const { code } = await run(hook.url, ["--file", tempFile("chart.png", PNG), tempFile("reply.md", text)]);
  await hook.close();
  assert.equal(code, 0);
  assert.equal(hook.received.length, 2);
  assert.equal(hook.received[0]!.contentType, "application/json");
  assert.match(hook.received[1]!.contentType, /^multipart\/form-data/);
});

test("a missing file stops before anything is posted", needsPython, async () => {
  const hook = await fakeWebhook();
  const { code, output } = await run(hook.url, ["--file", "/no/such/chart.png", tempFile("reply.md", "text")]);
  await hook.close();
  assert.notEqual(code, 0);
  assert.match(output, /cannot read/);
  assert.equal(hook.received.length, 0);
});

test("rejected buttons are dropped but the file is kept", needsPython, async () => {
  const hook = await fakeWebhook((req) => (req.body.includes("proposal:confirm") ? 400 : 200));
  const { code } = await run(hook.url, ["--confirm", "--file", tempFile("chart.png", PNG), tempFile("reply.md", "Proposal")]);
  await hook.close();
  assert.equal(code, 0);
  assert.equal(hook.received.length, 2);
  assert.match(parts(hook.received[1]!)[1]!.headers, /filename="chart.png"/);
});

test("the setup script carries the current discord-post (npm run setup-script)", () => {
  const helper = readFileSync(SCRIPT, "utf8").trimEnd();
  const setup = readFileSync(new URL("../cloud/setup-script.sh", import.meta.url), "utf8");
  assert.ok(setup.includes(`<<'DISCORD_POST_EOF'\n${helper}\nDISCORD_POST_EOF\n`));
});
