import { closeSync, constants, createReadStream, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createGunzip, createZstdDecompress } from "node:zlib";
import { setTimeout as wait } from "node:timers/promises";
import { buildPolicy, loadPolicy } from "../tooling/bend.ts";

type Step = { $: "Step"; session: string; line: string } | { $: "Rejected" };
type Projection = {
  run(id: string, thread: string, session: string, started: string, completed: string): string;
  rollout(session: string, envelope: string, kind: string, metadataId: string, callId: string,
    timestamp: string, ordinal: number): Step;
};

const object = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const string = (value: unknown) => typeof value === "string" ? value : "";
const millis = (value: unknown) => String(Date.parse(string(value)));

function decode(line: string) {
  try {
    return object(JSON.parse(line));
  } catch {
    return {};
  }
}

export async function fixturePolicy(scratch: string) {
  const path = process.env.PLOW_COLLECT_MODULE ?? await buildPolicy(scratch, new URL("./project.bend", import.meta.url), "collect.mjs");
  return loadPolicy<Projection>(path);
}

export function projectRollout(policy: Projection, raw: string) {
  let session = "";
  const output: string[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const envelope = decode(line);
    const payload = object(envelope.payload);
    const step = policy.rollout(session, string(envelope.type), string(payload.type), string(payload.id),
      string(payload.call_id),
      millis(envelope.timestamp), index + 1);
    if (step.$ === "Rejected") throw Error("Invalid or conflicting Codex session identity");
    session = step.session;
    if (step.line) output.push(step.line);
  }
  return output;
}

export function projectRun(policy: Projection, raw: string) {
  const run = object(JSON.parse(raw));
  const line = policy.run(string(run.id), string(run.threadId), string(run.sessionId), millis(run.startedAt), millis(run.completedAt));
  if (!line) throw Error("Invalid T3 run identity or clocks");
  return line;
}

export type WireList<T> = { $: "Nil" } | { $: "Con"; head: T; tail: WireList<T> };

export function wireList<T>(items: T[]): WireList<T> {
  return items.reduceRight<WireList<T>>((tail, head) => ({ $: "Con", tail, head }), { $: "Nil" });
}

export type Capture = {
  health(...fields: string[]): string;
  coverage(...fields: string[]): string;
  codex(...fields: string[]): string;
  poll_priority(updated: number, retry: number, now: number): number;
  inventory(items: WireList<{ $: "Target"; id: string; updated: number }>): WireList<{ id: string }>;
};

export async function capturePolicy(scratch: string) {
  const path = process.env.PLOW_CAPTURE_MODULE ?? await buildPolicy(scratch, new URL("./capture.bend", import.meta.url), "capture.mjs");
  return loadPolicy<Capture>(path);
}

function durableFile(path: string, content: string, immutable: boolean) {
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stage = join(directory, "." + randomUUID() + ".next");
  try {
    const file = openSync(stage, "wx", 0o600);
    try {
      writeFileSync(file, content);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    if (immutable) {
      try { linkSync(stage, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } else {
      renameSync(stage, path);
    }
    const folder = openSync(directory, "r");
    try { fsyncSync(folder); }
    finally { closeSync(folder); }
  } finally {
    rmSync(stage, { force: true });
  }
}

export function publish(directory: string, prefix: string, lines: string[]) {
  if (!lines.length) return;
  const body = lines.join("\n") + "\n";
  const digest = createHash("sha256").update(body).digest("hex");
  durableFile(join(directory, prefix + "-" + digest + ".jsonl"), body, true);
}

export function checkpoint(path: string, value: unknown) {
  durableFile(path, JSON.stringify(value) + "\n", false);
}

export function resume<T>(path: string, initial: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return initial;
  }
}

export function ordered(policy: Capture, items: { id: string; updated: number; retry?: number }[]) {
  const output: string[] = [];
  const now = Date.now();
  const ranked = items.map(({ id, updated, retry }) => ({
    $: "Target" as const, id, updated: policy.poll_priority(updated, retry ?? 0, now),
  }));
  for (let list = policy.inventory(wireList(ranked));
    list.$ === "Con"; list = list.tail) output.push(list.head.id);
  return output;
}

export function scopeArg(value: string | undefined) {
  if (!value || !/^[a-zA-Z0-9_-]{1,48}$/.test(value)) throw Error("Set a safe PLOW_CAPTURE_SCOPE alias");
  return value;
}

export function health(policy: Capture, spool: string, collector: string, scope: string, lane: string, status: string,
  observed: number, last: number, oldest: number, newest: number, scanned: number, eligible: number | null, ingested: number, reason: string) {
  const known = (value: number | null) => value === null ? "" : String(value);
  const line = policy.health(collector, scope, lane, status, String(observed), last ? String(last) : "",
    newest ? String(newest) : "", oldest ? String(oldest) : "", known(scanned), known(eligible), known(ingested),
    collector === "t3" ? "thread" : "session", reason);
  publish(join(spool, "health"), collector + "-" + scope + "-" + lane, [line]);
}

type Mark = { inode: string; offset: number; session: string; anchor: string; updated: number; size: number; done: boolean };
type CodexState = { started: number; last: number; oldest: number; newest?: number; count: number; paths: Record<string, Mark>; retries?: Record<string, number> };

function codexInventory(roots: string[]) {
  const items: { id: string; updated: number; size: number }[] = [];
  const queue = [...new Set(roots.map(root => resolve(root)))];
  let visited = 0;
  let compressed = false;
  while (queue.length) {
    const path = queue.pop()!;
    if (++visited > 100_000) throw Error("bounded_inventory");
    const st = lstatSync(path);
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) queue.push(join(path, name));
    } else if (st.isFile() && /^rollout-.*\.jsonl(?:\.(?:gz|zst|zip))?$/.test(basename(path))) {
      if (path.endsWith(".zip")) compressed = true;
      else items.push({ id: path, updated: Math.max(0, Math.floor(st.mtimeMs)), size: st.size });
    }
  }
  return { items, compressed };
}

function readBytes(file: number, offset: number, size: number) {
  const buffer = Buffer.alloc(size);
  return buffer.subarray(0, readSync(file, buffer, 0, size, offset));
}

function anchor(file: number, offset: number) {
  const size = Math.min(offset, 256);
  return readBytes(file, offset - size, size).toString("base64");
}

async function archiveBytes(file: number, offset: number, limit: number, zstd: boolean) {
  const input = createReadStream("", { fd: file, start: 0 });
  const closed = new Promise<void>(resolve => input.once("close", resolve));
  const decoder = zstd ? createZstdDecompress() : createGunzip();
  const forward = (error: Error) => decoder.destroy(error);
  input.on("error", forward);
  input.pipe(decoder);
  const chunks: Buffer[] = [];
  let position = 0;
  try {
    for await (const block of decoder) {
      const end = position + block.length;
      if (offset < end) chunks.push(block.subarray(Math.max(0, offset - position), Math.min(block.length, offset + limit - position)));
      position = end;
      if (position >= offset + limit) return { data: Buffer.concat(chunks), eof: false };
    }
    return { data: Buffer.concat(chunks), eof: true };
  } finally {
    input.destroy();
    decoder.destroy();
    await closed;
  }
}

async function codexFile(path: string, previous: Mark | undefined, project: Projection, policy: Capture) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let closeFile = true;
  try {
    const st = fstatSync(file);
    if (!st.isFile()) throw Error("source_unavailable");
    const inode = st.dev + ":" + st.ino;
    const zstd = path.endsWith(".zst");
    const compressed = zstd || path.endsWith(".gz");
    const updated = Math.floor(st.mtimeMs);
    const prior = previous?.inode === inode && (compressed
      ? previous.size === st.size && previous.updated === updated
      : previous.offset <= st.size && (previous.offset !== st.size || previous.updated === updated) &&
        previous.anchor === anchor(file, previous.offset)) ? previous : undefined;
    const offset = prior?.offset ?? 0;
    closeFile = !compressed;
    const chunk = compressed ? await archiveBytes(file, offset, 8 << 20, zstd) : {
      data: readBytes(file, offset, 8 << 20), eof: st.size - offset < 8 << 20,
    };
    const { data, eof } = chunk;
    const end = compressed && eof ? data.length - 1 : data.lastIndexOf(10);
    if (end < 0 && !eof) throw Error("record_limit");
    const lines: string[] = [];
    let oldest = 0;
    let newest = 0;
    let session = prior?.session ?? "";
    for (const line of data.subarray(0, end + 1).toString("utf8").split("\n")) {
      const envelope = decode(line);
      const payload = object(envelope.payload);
      const t = millis(envelope.timestamp);
      const step = project.rollout(session, string(envelope.type), string(payload.type), string(payload.id), "", t, 1);
      if (step.$ === "Rejected") throw Error("incomplete_projection");
      session = step.session;
      if (Number(t) > 0) {
        oldest = oldest ? Math.min(oldest, Number(t)) : Number(t);
        newest = Math.max(newest, Number(t));
      }
      if (envelope.type === "response_item") {
        const event = policy.codex(string(payload.type), session, string(payload.call_id), t);
        if (event) lines.push(event);
      }
    }
    const next = offset + end + 1;
    const done = compressed ? eof : next === st.size;
    return { lines, oldest, newest, done,
      mark: { inode, offset: next, session, anchor: compressed ? "" : anchor(file, next), updated, size: st.size, done } };
  } finally {
    if (closeFile) closeSync(file);
  }
}

async function captureCodex(lane: string, once: boolean) {
  const scope = scopeArg(process.env.PLOW_CAPTURE_SCOPE);
  const { PLOW_CODEX_ROOTS: roots, PLOW_CAPTURE_STATE: stateDir, PLOW_CAPTURE_SPOOL: spool } = process.env;
  if (!roots || !stateDir || !spool || !["live", "backfill"].includes(lane)) throw Error("Configure Codex capture roots, state and spool");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(stateDir, "codex-" + scope + "-" + lane + ".json");
  const state = resume<CodexState>(statePath, { started: Date.now(), last: 0, oldest: 0, count: 0, paths: {} });
  const retries = state.retries ??= {};
  const policy = await capturePolicy(stateDir);
  const project = await fixturePolicy(stateDir);
  do {
    let eligible: number | null = null;
    let scanned = 0;
    let reason = "";
    let status = "retrying";
    try {
      const { items, compressed } = codexInventory(roots.split(":").filter(Boolean));
      const current = items.filter(item => lane === "backfill" || item.updated >= state.started || state.paths[item.id]);
      eligible = compressed ? null : current.length;
      const pending = current.filter(item => {
        const mark = state.paths[item.id];
        return !mark?.done || item.size !== mark.size || item.updated !== mark.updated;
      });
      scanned = current.length - pending.length;
      const queue = ordered(policy, pending.map(item => ({ ...item, retry: retries[item.id] })));
      for (const file of queue.slice(0, 8)) {
        try {
          const result = await codexFile(file, state.paths[file], project, policy);
          publish(join(spool, "codex"), scope + "-" + lane, result.lines);
          state.paths[file] = result.mark;
          delete retries[file];
          if (result.oldest) state.oldest = state.oldest ? Math.min(state.oldest, result.oldest) : result.oldest;
          state.newest = Math.max(state.newest ?? 0, result.newest);
          state.count += result.lines.length;
          scanned += Number(result.done);
          checkpoint(statePath, state);
        } catch (error) {
          retries[file] = Date.now();
          reason = error instanceof Error && ["record_limit", "incomplete_projection"].includes(error.message)
            ? error.message : "source_unavailable";
        }
      }
      if (compressed && !reason) reason = "unsupported_archive";
      status = reason ? "retrying" : scanned < current.length ? "working" : lane === "backfill" ? "complete" : "idle";
      if (!reason) state.last = Date.now();
      checkpoint(statePath, state);
    } catch (error) {
      reason = error instanceof Error && error.message === "bounded_inventory" ? "bounded_inventory" : "source_unavailable";
    }
    const observed = Date.now();
    health(policy, spool, "codex_history", scope, lane, status, observed, state.last, state.oldest, state.newest ?? 0, scanned, eligible, state.count, reason);
    publish(join(spool, "codex"), scope + "-" + lane, [
      policy.coverage(scope, "codex_coverage", lane, status, String(observed), state.oldest ? String(state.oldest) : "", state.last ? String(state.last) : ""),
    ]);
    if (once && reason) process.exitCode = 1;
    if (!once) await wait(30_000);
  } while (!once);
}

if (import.meta.main && process.argv[2] === "--capture") {
  await captureCodex(process.argv[3], process.argv[4] === "--once");
} else if (import.meta.main) {
  const [workdir, ...extra] = process.argv.slice(2);
  if (!workdir || extra.length) throw Error("Expected the candidate work directory");
  const policy = await fixturePolicy(workdir);
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  const events = projectRollout(policy, fixture("codex.jsonl"));
  const run = projectRun(policy, fixture("t3.json"));
  const spool = join(workdir, "spool");
  mkdirSync(spool, { mode: 0o700 });
  writeFileSync(join(spool, "codex.jsonl"), events.join("\n") + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(spool, "t3.jsonl"), run + "\n", { flag: "wx", mode: 0o600 });
}
