import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { capturePolicy, checkpoint, health, ordered, publish, resume, scopeArg } from "../fixture.ts";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";

type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
type Binding = { $: "T3Binding"; owner: string; driver: string; native_driver: string; strength: string; session: string; reference: string };
type Run = { $: "T3Run"; owner: string; id: string; started: string; completed: string };
type Policy = { t3_run(thread: string, requested: string, refs: List<Binding>, runs: List<Run>): string };

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid T3 response");
  return input as Record<string, unknown>;
}

function list<T>(input: unknown, cap: number, decode: (input: unknown) => T): List<T> {
  if (!Array.isArray(input) || input.length > cap) throw Error("Invalid or oversized T3 result list");
  return input.reduceRight<List<T>>((tail, entry) => ({ $: "Con", head: decode(entry), tail }), { $: "Nil" });
}

const text = (input: unknown) => typeof input === "string" ? input : "";
const ms = (input: unknown) => String(Date.parse(text(input)));

function bindings(projection: Record<string, unknown>) {
  return list<Binding>(projection.providerThreads, 64, value => {
    const item = object(value);
    const native = object(item.nativeThreadRef ?? {});
    return { $: "T3Binding", owner: text(item.appThreadId), driver: text(item.driver),
      native_driver: text(native.driver), strength: text(native.strength), session: text(native.nativeId), reference: text(item.id) };
  });
}

export async function projectT3Run(scratch: string, thread: string, requested: string, input: unknown) {
  const projection = object(object(input).projection);
  if (object(projection.thread).id !== thread) throw Error("T3 response belongs to another thread");
  const ref = bindings(projection);
  const runs = list<Run>(projection.runs, 4096, value => {
    const item = object(value);
    return { $: "T3Run", owner: text(item.threadId), id: text(item.id),
      started: ms(item.startedAt), completed: ms(item.completedAt) };
  });
  const module = await buildPolicy(scratch, new URL("../project.bend", import.meta.url), "t3-run.mjs");
  const policy = await loadPolicy<Policy>(module);
  const result = policy.t3_run(thread, requested, ref, runs);
  if (!result) throw Error("T3 run or Codex session binding is missing or ambiguous");
  return result;
}

class SourceError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("T3 source request returned HTTP " + status);
    this.status = status;
  }
}

function sourceURL(path: string, origin: string) {
  const url = new URL(path, origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
    throw Error("Use HTTPS or a loopback fixture T3 origin");
  }
  return url;
}

async function source(url: URL, token: string, limit: number, method = "GET", timeout = 5000) {
  const response = await fetch(url, { method, headers: { authorization: "Bearer " + token,
    "x-t3-orchestration-protocol": "2" }, redirect: "error", signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new SourceError(response.status);
  }
  const reader = response.body.getReader();
  const blocks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const block = await reader.read();
      if (block.done) break;
      bytes += block.value.length;
      if (bytes > limit) throw Error("T3 source response exceeded its byte limit");
      blocks.push(block.value);
    }
  } finally {
    await reader.cancel();
  }
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(blocks))));
}

async function read(origin: string, token: string, thread: string, cursor = "") {
  const url = sourceURL("/api/orchestration/threads/" + encodeURIComponent(thread) + (cursor ? "/history" : "/bounded"), origin);
  if (cursor) {
    url.searchParams.set("cursor", cursor);
    url.searchParams.set("view", "activity");
  } else {
    url.searchParams.set("dedupeBodies", "1");
  }
  return source(url, token, 8 << 20);
}

async function archived(origin: string, token: string) {
  const response = await source(sourceURL("/api/auth/websocket-ticket", origin), token, 8192, "POST");
  const ticket = text(response.ticket);
  if (!ticket || ticket.length > 4096) throw Error("Invalid T3 websocket ticket");
  const address = sourceURL("/ws", origin);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  address.searchParams.set("orchestrationProtocol", "2");
  address.searchParams.set("wsTicket", ticket);
  const socket = new WebSocket(address);
  const signal = AbortSignal.timeout(15_000);
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const fail = () => reject(Error("Archived T3 inventory unavailable"));
      signal.addEventListener("abort", fail, { once: true });
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        _tag: "Request", id: "1", tag: "orchestration.getArchivedShellSnapshot", payload: {}, headers: [],
      })));
      socket.addEventListener("message", event => {
        try {
          if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 64 << 20) return fail();
          for (const item of [JSON.parse(event.data)].flat()) {
            const frame = object(item);
            if (frame._tag !== "Exit" || frame.requestId !== "1") continue;
            const result = object(frame.exit);
            return result._tag === "Success" ? resolve(object(result.value)) : fail();
          }
        } catch { fail(); }
      });
    });
  } finally {
    socket.close();
  }
}

type Capture = Awaited<ReturnType<typeof capturePolicy>> & {
  run(scope: string, thread: string, id: string, owner: string, status: string, requested: string,
    started: string, completed: string, revision: string, observed: string, provider: string, refs: List<Binding>): string;
  operation(...fields: string[]): string;
  pr_link(...fields: string[]): string;
  page(previous: string, next: string, more: boolean): boolean;
};

function array(input: unknown, cap: number) {
  if (!Array.isArray(input) || input.length > cap) throw Error("bounded_inventory");
  return input.map(object);
}

type Page = { lines: string[]; next: string; oldest: number; runHistoryGap: boolean };

function page(policy: Capture, scope: string, thread: string, input: Record<string, unknown>, cursor: string, observed: number): Page {
  const next = cursor ? input.nextCursor : input.historyCursor;
  if ((next !== null && (typeof next !== "string" || next.length > 4096)) ||
      typeof input.hasMoreHistory !== "boolean" || !policy.page(cursor, text(next), input.hasMoreHistory) ||
      typeof input.snapshotSequence !== "number" || !Number.isSafeInteger(input.snapshotSequence) || input.snapshotSequence < 0) {
    throw Error("incomplete_projection");
  }
  const lines: string[] = [];
  let oldest = 0;
  let runHistoryGap = false;
  const observe = (value: number) => { if (value > 0) oldest = oldest ? Math.min(oldest, value) : value; };
  let items;
  if (cursor) {
    items = array(input.items, 4096).map(entry => ({ item: object(entry.item),
      owner: text(entry.sourceThreadId), visibility: text(entry.visibility) }));
  } else {
    const projection = object(input.projection);
    const head = object(projection.thread);
    if (head.id !== thread) throw Error("incomplete_projection");
    const refs = bindings(projection);
    const runs = array(projection.runs, 4096);
    runHistoryGap = input.hasMoreHistory === true || runs.length === 4096;
    for (const run of runs) {
      const line = policy.run(scope, thread, text(run.id), text(run.threadId), text(run.status),
        ms(run.requestedAt), ms(run.startedAt), ms(run.completedAt), ms(run.updatedAt ?? head.updatedAt), String(observed), text(run.providerThreadId), refs);
      if (line) {
        lines.push(line);
        observe(Number(ms(run.requestedAt)) || Number(ms(run.startedAt)) || Number(ms(run.completedAt)));
      }
    }
    for (const pr of array(head.pullRequests ?? [], 100)) {
      const link = policy.pr_link(scope, thread, text(pr.host), text(pr.repository), String(pr.number ?? ""),
        text(pr.source), ms(head.updatedAt), String(observed));
      if (link) lines.push(link);
    }
    items = array(projection.turnItems, 4096).map(item => ({ item, owner: text(item.threadId), visibility: "local" }));
  }
  for (const { item, owner, visibility } of items) {
    const native = object(item.nativeItemRef ?? {});
    const line = policy.operation(scope, thread, text(item.id), owner === text(item.threadId) ? owner : "", visibility,
      text(item.runId), text(item.type), text(native.driver), text(native.strength), ms(item.startedAt),
      ms(item.completedAt), ms(item.updatedAt), String(observed));
    if (owner === thread && visibility === "local") observe(Number(ms(item.startedAt)) || Number(ms(item.updatedAt)));
    if (line) lines.push(line);
  }
  return { lines, next: text(next), oldest, runHistoryGap };
}

type T3Mark = { revision: number; cursor: string; oldest: number; uncertain: boolean; previous: string[]; retry?: number };
type State = { last: number; oldest: number; count: number; marks: Record<string, T3Mark> };

async function capture(lane: string, once: boolean, origin: string, tokenFile: string) {
  const scope = scopeArg(process.env.PLOW_CAPTURE_SCOPE);
  const { PLOW_CAPTURE_STATE: stateDir, PLOW_CAPTURE_SPOOL: spool } = process.env;
  if (!stateDir || !spool || !["live", "backfill"].includes(lane)) throw Error("Configure T3 capture state and spool");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const policy = await capturePolicy(stateDir) as Capture;
  const statePath = join(stateDir, "t3-" + scope + "-" + lane + ".json");
  const state = resume<State>(statePath, { last: 0, oldest: 0, count: 0, marks: Object.create(null) });
  Object.setPrototypeOf(state.marks, null);
  do {
    const observed = Date.now();
    let eligible = null;
    let scanned = 0;
    let newest = 0;
    let reason = "";
    let status = "retrying";
    try {
      const token = readFileSync(tokenFile, "utf8").trim();
      const inventory = await Promise.allSettled([
        source(sourceURL("/api/orchestration/shell", origin), token, 64 << 20, "GET", 15_000),
        archived(origin, token),
      ]);
      const targets = new Map<string, number>();
      for (const result of inventory) {
        if (result.status === "rejected") {
          reason = result.reason instanceof SourceError && [401, 403].includes(result.reason.status) ? "access" : "source_unavailable";
          continue;
        }
        for (const entry of array(result.value.threads, 50_000)) {
          const id = text(entry.id);
          if (id.length > 512 || !/^[A-Za-z0-9](?:[A-Za-z0-9:_-]|%[A-Fa-f0-9]{2})*$/.test(id)) continue;
          const stamp = Number(ms(entry.updatedAt)) || Number(ms(entry.createdAt)) || 0;
          targets.set(id, Math.max(stamp, targets.get(id) ?? 0));
        }
      }
      for (const stamp of targets.values()) newest = Math.max(newest, stamp);
      if (!reason) eligible = targets.size;
      const pending = [];
      for (const [id, updated] of targets) {
        const mark = state.marks[id];
        if (!mark || mark.revision < updated || (lane === "backfill" && mark.cursor)) pending.push({ id, updated: mark?.cursor ? mark.oldest : updated, retry: mark?.retry });
        else scanned++;
      }
      for (const thread of ordered(policy, pending).slice(0, 8)) {
        const old = state.marks[thread];
        const revision = targets.get(thread)!;
        const cursor = lane === "backfill" && old ? old.cursor : "";
        try {
          const result = page(policy, scope, thread, await read(origin, token, thread, cursor), cursor, observed);
          if (result.next && old?.previous.includes(result.next)) throw Error("incomplete_projection");
          if (result.next && (old?.previous.length ?? 0) >= 10_000) throw Error("bounded_inventory");
          publish(join(spool, "t3"), scope + "-" + lane, result.lines);
          const oldest = old?.oldest && result.oldest ? Math.min(old.oldest, result.oldest) : old?.oldest || result.oldest;
          state.marks[thread] = {
            revision: cursor && old ? old.revision : revision,
            cursor: lane === "backfill" ? result.next : "",
            oldest, uncertain: result.runHistoryGap || !!(cursor && old?.uncertain),
            previous: result.next && lane === "backfill" ? [...(cursor ? old!.previous : []), result.next] : [],
          };
          if (oldest) state.oldest = state.oldest ? Math.min(state.oldest, oldest) : oldest;
          state.count += result.lines.length;
          scanned += Number(!state.marks[thread].cursor && state.marks[thread].revision === revision);
          checkpoint(statePath, state);
        } catch (error) {
          const retry = Date.now();
          const initial = { cursor: "", revision: -1, oldest: 0, previous: [], uncertain: false };
          state.marks[thread] = { ...(old ?? initial), retry };
          if (cursor && error instanceof SourceError && error.status === 400) {
            state.marks[thread] = { ...initial, oldest: old!.oldest, retry };
          }
          checkpoint(statePath, state);
          reason ||= error instanceof SourceError && [401, 403].includes(error.status) ? "access" : "source_unavailable";
        }
      }
      if (!reason) {
        status = scanned < targets.size ? "working" : lane === "backfill" ? "complete" : "idle";
        if (status === "idle" || status === "complete") state.last = observed;
        checkpoint(statePath, state);
        if (Object.values(state.marks).some(mark => mark.uncertain)) reason = "incomplete_projection";
      }
    } catch (error) {
      reason = error instanceof Error && error.message === "bounded_inventory" ? "bounded_inventory" : "source_unavailable";
    }
    health(policy, spool, "t3", scope, lane, status, observed, state.last, state.oldest, newest, scanned, eligible, state.count, reason);
    if (lane === "live") {
      const progress = resume<State>(join(stateDir, "t3-" + scope + "-backfill.json"), { last: 0, oldest: 0, count: 0, marks: {} });
      publish(join(spool, "t3"), scope + "-" + lane, [policy.coverage(scope, "t3_coverage", lane, status,
        String(observed), String(progress.oldest || state.oldest), String(state.last))]);
    }
    if (once && status === "retrying") process.exitCode = 1;
    if (!once) await wait(15_000);
  } while (!once);
}

async function main() {
  const [thread, run, ...extra] = process.argv.slice(2);
  const { PLOW_T3_ORIGIN: origin, PLOW_T3_READ_TOKEN_FILE: tokenFile } = process.env;
  if (thread === "--capture" && run && origin && tokenFile) {
    return capture(run, extra[0] === "--once", origin, tokenFile);
  }
  if (!origin || !tokenFile || !thread || !run || extra.length) {
    throw Error("Set PLOW_T3_ORIGIN and PLOW_T3_READ_TOKEN_FILE and pass THREAD RUN");
  }
  const scratch = mkdtempSync("/tmp/apparent-dev-plow-t3-run-");
  try {
    const data = await read(origin, readFileSync(tokenFile, "utf8").trim(), thread);
    process.stdout.write(await projectT3Run(scratch, thread, run, data) + "\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
