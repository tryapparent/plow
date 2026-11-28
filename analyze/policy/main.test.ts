import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./main.ts", import.meta.url));
const epoch = 1_700_000_000_000;
const run = { id: "run-fixture", threadId: "thread-fixture", sessionId: "session-fixture",
  startedMs: epoch, completedMs: epoch + 10_000 };

function event(eventId: string, callId: string, offset: number, output = false, sessionId = run.sessionId) {
  return { eventId, sessionId, callId, kind: output ? "function_call_output" : "function_call",
    timestampMs: epoch + offset };
}

function execute(input: unknown) {
  return spawnSync(process.execPath, [cli], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30_000,
  });
}

function analyze(events: ReturnType<typeof event>[], window = run) {
  const result = execute({ run: window, events });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function interval(callId: string, start: number | null, end: number | null, durationMs: number | null) {
  return { callId, kind: "function_call", startMs: start === null ? null : epoch + start,
    endMs: end === null ? null : epoch + end, durationMs };
}

test("pairs tool calls within the selected session and preserves unknown coverage on replay", () => {
  const events = [
    event("a-end", "a", 3000, true),
    event("b-start", "b", 2000),
    event("a-start", "a", 1000),
    event("c-end", "c", 10_000, true),
    event("c-start", "c", -1),
    event("foreign-end", "b", 3000, true, "other-session"),
    event("future-end", "b", 10_001, true),
    event("d-start", "d", 2500),
    event("d-end", "d", 4000, true),
  ];
  const output = analyze(events);
  assert.deepEqual(JSON.parse(output), {
    runId: run.id,
    intervals: [
      interval("a", 1000, 3000, 2000),
      interval("b", 2000, null, null),
      interval("c", null, 10_000, null),
      interval("d", 2500, 4000, 1500),
    ],
    findings: [
      { callId: "b", reason: "missing_end" },
      { callId: "c", reason: "missing_start" },
    ],
    coverage: { events: 6, paired: 2, unknown: 2 },
  });
  assert.equal(analyze([...events, ...events].reverse()), output);
});

test("fails closed on conflicting identities, ambiguous endpoints, and reversed clocks", () => {
  const events = [
    event("shared", "collision", 1000),
    event("shared", "foreign", 1000, false, "other-session"),
    event("alternative", "collision", 1000),
    event("collision-end", "collision", 4000, true),
    event("ambiguous-a", "ambiguous", 1000),
    event("ambiguous-b", "ambiguous", 1000),
    event("ambiguous-end", "ambiguous", 3000, true),
    event("reversed-start", "reversed", 3000),
    event("reversed-end", "reversed", 1000, true),
    event("cross-call", "one", 8000),
    event("cross-call", "two", 9000, true),
  ];
  const output = analyze(events);
  assert.deepEqual(JSON.parse(output), {
    runId: run.id,
    intervals: [
      interval("ambiguous", null, 3000, null),
      interval("collision", null, 4000, null),
      interval("one", null, null, null),
      interval("reversed", 3000, 1000, null),
      interval("two", null, null, null),
    ],
    findings: [
      { callId: "ambiguous", reason: "ambiguous_start" },
      { callId: "collision", reason: "conflicting_event_id" },
      { callId: "one", reason: "conflicting_event_id" },
      { callId: "reversed", reason: "reversed_clock" },
      { callId: "two", reason: "conflicting_event_id" },
    ],
    coverage: { events: 9, paired: 0, unknown: 5 },
  });
  assert.equal(analyze([...events, ...events].reverse()), output);
});

test("round-trips signed millisecond clocks and rejects invalid run windows", () => {
  const signedWindow = { ...run, startedMs: -1, completedMs: 1 };
  const events = [
    { ...event("start", "call", 0), timestampMs: -1 },
    { ...event("end", "call", 0, true), timestampMs: 1 },
  ];
  const result = JSON.parse(analyze(events, signedWindow));
  assert.deepEqual(result.intervals, [
    { callId: "call", kind: "function_call", startMs: -1, endMs: 1, durationMs: 2 },
  ]);

  const invalid = execute({ run: { ...run, startedMs: run.completedMs + 1 }, events: [] });
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Policy rejected the run identity or clock window/);
});

test("Activity clips and disjoins threads, preserves cross-thread time, and leaves empty buckets null", () => {
  const hour = 3_600_000;
  const to = epoch + 100 * hour;
  const at = (hours: number) => to - hours * hour;
  function record(id: string, thread: string, request: number, start: number | null, end: number | null, session = "") {
    return { kind: "t3_activity_run", eventId: id, timestampMs: end ?? start ?? request,
      observedMs: to, revisionMs: end ?? start ?? request,
      run: { id, threadId: thread, sessionId: session, requestedMs: request, startedMs: start, completedMs: end } };
  }
  const rows = [
    record("a", "t1", at(26), at(25), at(22), "exact-session"),
    record("b", "t1", at(23), at(21), at(20)),
    record("c", "t2", at(24), at(23), at(20)),
    record("d", "t1", at(12), null, at(11)),
    { kind: "operation", eventId: "safe", threadId: "t1", t3RunId: "a", operation: "command_execution",
      timestampMs: at(22.5), startedMs: at(23), completedMs: at(22.5), observedMs: to },
    { kind: "operation", eventId: "unsafe", threadId: "t1", t3RunId: "a", operation: "private fixture text",
      timestampMs: at(23), startedMs: at(24), completedMs: at(23), observedMs: to },
    { kind: "t3_coverage", eventId: "checkpoint", timestampMs: to, status: "idle", observedMs: to },
  ];
  const ci = { repository: "fixture/repo", runId: 4, attempt: 2, headSha: "a".repeat(40), observedMs: to };
  const link = { kind: "t3_pr_link", eventId: "link", threadId: "t1", repository: ci.repository,
    prNumber: "42", timestampMs: at(12) };
  const workflow = { ...ci, kind: "github_actions_attempt", eventId: "attempt", prNumber: "42", timestampMs: at(10),
    createdMs: at(14), startedMs: at(13), completedMs: at(10) };
  const job = { ...ci, kind: "github_actions_job", eventId: "job-a", jobId: 11, timestampMs: at(10),
    createdMs: at(13), executionStartedMs: at(12), executionCompletedMs: at(10), conclusion: "failure" };
  const newer = record("d", "t1", at(12), at(11.5), at(11));
  newer.revisionMs++;
  newer.observedMs = to + 1;
  function activity(input: unknown[], range: string, operation = "all") {
    const result = execute({ to, range, operation, records: {
      t3_history: input.map(item => JSON.stringify(item)),
      github_history: [workflow, job, { ...job, eventId: "prior-job-a", observedMs: to - 1,
        executionStartedMs: at(13) }, { ...job, eventId: "job-b", jobId: 12, headSha: "b".repeat(40) }].map(item => JSON.stringify(item)),
    } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  const input = [...rows, link, newer];
  const output = activity(input, "24h");
  const result = JSON.parse(output);
  assert.equal(result.cutoff, to);
  assert.equal(result.from, at(24));
  assert.equal(result.links[0].first, at(25));
  assert.equal(result.unknownRuns, 1);
  assert.equal(result.buckets[0].share, 7500);
  assert.equal(result.buckets.at(-1).share, null);
  assert.equal(result.ci.length, 2);
  assert.equal(result.findings.find((finding: { kind: string }) => finding.kind === "CI failures").ms, 2 * hour);
  assert.ok(result.totals.some((row: { operation: string; ms: number }) => row.operation === "Command execution" && row.ms === hour / 2));
  assert.ok(result.totals.some((row: { operation: string; ms: number }) => row.operation === "Missing clocks" && row.ms === hour));
  assert.doesNotMatch(output, /private fixture text/);
  assert.deepEqual(JSON.parse(activity(input, "24h", "Command execution")).threads.map((lane: { id: string }) => lane.id), ["t1"]);
  const days = JSON.parse(activity(input, "7d")).buckets;
  assert.equal(days.length, 7);
  assert.equal(days[1].time - days[0].time, 24 * hour);
  assert.equal(activity([...input, ...input].reverse(), "24h"), output);
});
