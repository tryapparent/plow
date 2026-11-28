import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("bounded T3 read projects an exact local run and rejects ambiguous bindings", async () => {
  const scratch = mkdtempSync("/tmp/apparent-dev-plow-t3-fixture-");
  const token = join(scratch, "token");
  writeFileSync(token, "synthetic-read-token\n", { mode: 0o600 });
  const refs = [{ appThreadId: "fixture-thread", driver: "codex", nativeThreadRef: {
    driver: "codex", strength: "strong", nativeId: "fixture-session",
  } }];
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/orchestration/threads/fixture-thread/bounded?dedupeBodies=1");
    assert.equal(request.headers.authorization, "Bearer synthetic-read-token");
    assert.equal(request.headers["x-t3-orchestration-protocol"], "2");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ projection: {
      thread: { id: "fixture-thread", title: "fixture private canary" },
      providerThreads: refs,
      runs: [{ threadId: "fixture-thread", id: "run:fixture", startedAt: "2025-06-03T12:00:00Z",
        completedAt: "2025-06-03T12:00:10Z" }],
    } }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const args = [fileURLToPath(new URL("./read.ts", import.meta.url)), "fixture-thread", "run:fixture"];
    const env = { ...process.env, PLOW_T3_ORIGIN: "http://127.0.0.1:" + address.port, PLOW_T3_READ_TOKEN_FILE: token };
    const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, output }));
    });
    const result = await run();
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.output), { kind: "t3_run", run: {
      id: "run:fixture", threadId: "fixture-thread", sessionId: "fixture-session",
      startedMs: 1748952000000, completedMs: 1748952010000,
    } });
    refs.push({ ...refs[0], nativeThreadRef: { ...refs[0].nativeThreadRef, nativeId: "another-session" } });
    assert.deepEqual(await run(), { code: 1, output: "" });
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("T3 live head and durable opaque backfill advance independently", async () => {
  const scratch = mkdtempSync("/tmp/apparent-dev-plow-t3-cursors-");
  const token = join(scratch, "token");
  const state = join(scratch, "state");
  const spool = join(scratch, "spool");
  writeFileSync(token, "fixture-read\n", { mode: 0o600 });
  const now = new Date(Date.now() - 10_000).toISOString();
  const old = "2025-06-03T12:00:00.000Z";
  const cursor = "+opaque/fixture=";
  let unavailable = false;
  let discovered = false;
  let pageReads = 0;
  const active = [{ id: "thread-active", updatedAt: now }];
  const archived = { id: "thread-archived", updatedAt: old };
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-read");
    const url = new URL(request.url!, "http://127.0.0.1");
    const reply = (value: unknown) => response.end(JSON.stringify(value));
    if (url.pathname.endsWith("/websocket-ticket")) return reply({ ticket: "fixture-ticket" });
    if (url.pathname.endsWith("/shell")) return reply({ threads: discovered ? [...active, { id: "thread-new", updatedAt: now }] : active });
    const id = url.pathname.split("/").at(-2)!;
    if (url.pathname.endsWith("/history")) {
      assert.equal(url.searchParams.get("cursor"), cursor);
      assert.equal(url.searchParams.get("view"), "activity");
      pageReads++;
      if (unavailable) { response.writeHead(503); return response.end(); }
      return reply({ hasMoreHistory: false, nextCursor: null, snapshotSequence: 1, items: [] });
    }
    const more = id === "thread-archived";
    const start = more ? old : now;
    return reply({ hasMoreHistory: more, historyCursor: more ? cursor : null, snapshotSequence: 1,
      projection: { thread: { id, updatedAt: start, title: "private fixture title" },
        providerThreads: more ? [] : [{ id: "provider-ref", appThreadId: id, driver: "codex",
          nativeThreadRef: { driver: "codex", strength: "strong", nativeId: "safe-session" } }], turnItems: [],
        runs: [{ id: id + "-run", threadId: id, providerThreadId: "provider-ref",
          requestedAt: start, startedAt: start, completedAt: null, status: "running" }] } });
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    socket.once("data", () => {
      const payload = Buffer.from(JSON.stringify({ _tag: "Exit", requestId: "1",
        exit: { _tag: "Success", value: { threads: [archived] } } }));
      const header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
      socket.write(Buffer.concat([header, payload]));
      socket.once("data", () => socket.end());
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const env = { ...process.env, PLOW_T3_ORIGIN: "http://127.0.0.1:" + address.port,
      PLOW_T3_READ_TOKEN_FILE: token, PLOW_CAPTURE_SCOPE: "fixture", PLOW_CAPTURE_STATE: state, PLOW_CAPTURE_SPOOL: spool };
    const capture = (lane: string) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./read.ts", import.meta.url)), "--capture", lane, "--once"], { env, stdio: "inherit" });
      child.on("error", reject);
      child.on("close", resolve);
    });
    const marks = () => JSON.parse(readFileSync(join(state, "t3-fixture-backfill.json"), "utf8")).marks;
    assert.equal(await capture("backfill"), 0);
    assert.equal(marks()["thread-archived"].cursor, cursor);
    unavailable = true;
    assert.equal(await capture("backfill"), 1);
    assert.equal(marks()["thread-archived"].cursor, cursor);
    discovered = true;
    assert.equal(await capture("live"), 0);
    assert.equal(pageReads, 1);
    unavailable = false;
    assert.equal(await capture("backfill"), 0);
    assert.equal(marks()["thread-archived"].cursor, "");
    assert.equal(await capture("backfill"), 0);
    assert.equal(pageReads, 2);
    const output = readdirSync(join(spool, "t3")).map(file => readFileSync(join(spool, "t3", file), "utf8")).join("");
    assert.match(output, /thread-new-run/);
    assert.match(output, /thread-archived-run/);
    assert.match(output, /"sessionId":""/);
    assert.match(output, /"sessionId":"safe-session"/);
    assert.doesNotMatch(output, /private fixture title|fixture-read|opaque/);
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
