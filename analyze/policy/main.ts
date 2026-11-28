import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
type MaybeNat = { $: "None" } | { $: "Some"; value: bigint };

type Run = {
  $: "Run";
  id: string;
  threadId: string;
  sessionId: string;
  startedMs: bigint;
  completedMs: bigint;
};

type ToolEvent = {
  $: "ToolEvent";
  eventId: string;
  sessionId: string;
  callId: string;
  kind: string;
  timestampMs: bigint;
};

type Interval = {
  callId: string;
  kind: string;
  startMs: MaybeNat;
  endMs: MaybeNat;
  durationMs: MaybeNat;
};

type Finding = { callId: string; reason: string };

type Report = { $: "Rejected" } | {
  $: "Report";
  runId: string;
  intervals: List<Interval>;
  findings: List<Finding>;
  events: bigint;
  paired: bigint;
  unknown: bigint;
};

const clockOffset = BigInt(Number.MAX_SAFE_INTEGER);

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Error(`Expected an object for ${field}`);
  }
  return value as Record<string, unknown>;
}

function string(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw Error(`Expected a string for ${field}`);
  return value;
}

function clock(row: Record<string, unknown>, field: string): bigint {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw Error(`Expected a safe integer millisecond clock for ${field}`);
  }
  return BigInt(value) + clockOffset;
}

function decode(input: unknown) {
  const request = object(input, "request");
  const run = object(request.run, "run");
  if (!Array.isArray(request.events)) throw Error("Expected an events array");

  const events = request.events.reduceRight<List<ToolEvent>>((tail, value) => {
    const row = object(value, "event");
    return { $: "Con", tail, head: {
      $: "ToolEvent",
      eventId: string(row, "eventId"),
      sessionId: string(row, "sessionId"),
      callId: string(row, "callId"),
      kind: string(row, "kind"),
      timestampMs: clock(row, "timestampMs"),
    } };
  }, { $: "Nil" });

  return {
    run: {
      $: "Run",
      id: string(run, "id"),
      threadId: string(run, "threadId"),
      sessionId: string(run, "sessionId"),
      startedMs: clock(run, "startedMs"),
      completedMs: clock(run, "completedMs"),
    } satisfies Run,
    events,
  };
}

function array<T, R>(list: List<T>, encode: (item: T) => R): R[] {
  const values: R[] = [];
  for (let row = list; row.$ === "Con"; row = row.tail) values.push(encode(row.head));
  return values;
}

function nullable(value: MaybeNat, offset = 0n) {
  return value.$ === "None" ? null : JSON.rawJSON(String(value.value - offset));
}

function nat(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const field = (value: unknown) => typeof value === "string" && value.length <= 768 ? value : "";

function evidence(source: string, value: unknown) {
  const row = object(value, "evidence record");
  const run = object(row.run ?? {}, "run");
  const kind = field(row.kind);
  const wireKinds: Record<string, Record<string, string>> = {
    t3: { t3_run: "run" },
    t3_history: { t3_activity_run: "run", t3_coverage: "t3_coverage", operation: "operation",
      t3_ci_link: "t3_ci_link", t3_pr_link: "t3_pr_link", confirmed_delay: "confirmed_delay" },
    github_history: { github_pr: "github_pr", github_actions_attempt: "github_actions_attempt",
      github_actions_job: "github_actions_job", github_release: "github_release", github_coverage: "github_coverage" },
    codex_history: { codex_coverage: "codex_coverage" },
  };
  return {
    $: "Evidence", source,
    kind: Object.hasOwn(wireKinds[source] ?? {}, kind) ? wireKinds[source][kind] : "",
    id: field(row.eventId ?? run.id),
    thread: field(row.threadKey ?? run.threadId ?? row.threadId),
    run: field(run.id ?? row.t3RunId ?? String(row.runId ?? "")), session: field(run.sessionId ?? row.sessionId),
    group: field(row.operation ?? String(row.prNumber ?? "")), status: field(run.status ?? row.conclusion ?? row.status),
    stamp: nat(row.timestampMs ?? run.completedMs), seen: nat(row.observedMs),
    revision: nat(row.revisionMs ?? row.sourceUpdatedMs ?? row.updatedMs ?? row.observedMs),
    first: nat(run.requestedMs ?? row.requestedMs ?? row.createdMs ?? row.oldestSourceMs),
    start: nat(run.startedMs ?? row.executionStartedMs ?? row.startedMs ?? (Object.hasOwn(row, "cutoffMs") ? row.cutoffMs : (kind.endsWith("_coverage") ? row.timestampMs : null))),
    end: nat(run.completedMs ?? row.executionCompletedMs ?? row.completedMs),
    repository: field(row.repository), attempt: String(row.attempt ?? ""),
    sha: field(row.headSha), job: String(row.jobId ?? ""),
  };
}

async function activity(request: Record<string, unknown>, module: string) {
  const records = object(request.records, "source records");
  let input: List<ReturnType<typeof evidence>> = { $: "Nil" };
  let partial = request.partial === true;
  for (const [source, lines] of Object.entries(records)) {
    if (lines === null) continue;
    if (!Array.isArray(lines)) throw Error("Expected a bounded list of source records");
    for (const line of lines) {
      try {
        const head = evidence(source, JSON.parse(line));
        input = { $: "Con", head, tail: input };
      } catch {
        partial = true;
      }
    }
  }
  const { default: policy } = await import(pathToFileURL(module).href);
  const report = request.view === "lookup"
    ? array(policy.lookup(input, nat(request.to)), row => row)
    : policy.activity(input, string(request, "range"), nat(request.to), partial, string(request, "operation"));
  process.stdout.write(JSON.stringify(report, (_key, value) => {
    if (typeof value === "bigint") return Number(value);
    if (value?.$ === "None") return null;
    if (value?.$ === "Some") return value.value;
    if (value?.$ === "Con" || value?.$ === "Nil") return array(value, row => row);
    if (value?.$) {
      const { $: _, ...fields } = value;
      return fields;
    }
    return value;
  }) + "\n");
}

async function compile(directory: string) {
  const { buildPolicies } = await import("../../tooling/bend.ts");
  return buildPolicies(directory, [
    [new URL("./run.bend", import.meta.url), "run.mjs"],
    [new URL("./activity.bend", import.meta.url), "activity.mjs"],
  ]);
}

async function main() {
  const [mode, directory, ...extra] = process.argv.slice(2);
  if (mode === "--compile" && directory && !extra.length) {
    await compile(directory);
    return;
  }
  if (mode !== undefined) throw Error("Expected --compile DIRECTORY or a JSON request on stdin");
  const request = object(JSON.parse(readFileSync(0, "utf8")), "request");
  const range = typeof request.range === "string";
  const configured = range ? process.env.PLOW_ACTIVITY_MODULE : process.env.PLOW_POLICY_MODULE;
  const scratch = configured ? undefined : mkdtempSync("/tmp/apparent-dev-plow-policy-");
  try {
    const module = scratch ? (await compile(scratch))[range ? 1 : 0] : configured!;
    if (range) return await activity(request, module);
    const { run, events } = decode(request);
    const { default: policy } = await import(pathToFileURL(module).href) as {
      default: { analyze(run: Run, events: List<ToolEvent>): Report };
    };
    const report = policy.analyze(run, events);
    if (report.$ === "Rejected") throw Error("Policy rejected the run identity or clock window");

    process.stdout.write(JSON.stringify({
      runId: report.runId,
      intervals: array(report.intervals, ({ callId, kind, startMs, endMs, durationMs }) => ({
        callId, kind,
        startMs: nullable(startMs, clockOffset),
        endMs: nullable(endMs, clockOffset),
        durationMs: nullable(durationMs),
      })),
      findings: array(report.findings, ({ callId, reason }) => ({ callId, reason })),
      coverage: { events: Number(report.events), paired: Number(report.paired), unknown: Number(report.unknown) },
    }) + "\n");
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
