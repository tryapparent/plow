# Historical fixture collection

The fixture projector reads the two files in [fixtures](fixtures/) and writes normalized, newline-delimited JSON to a private candidate spool. The TypeScript host decodes JSON and ISO timestamps, calls the compiled policy, and writes files. [Bend2](project.bend) checks identifiers and clocks, binds Codex events to the observed session, and constructs a fresh allowlisted JSON body. Filename, working directory, prompt, tool name, arguments, and output stay out of the spool.

Codex event IDs are the session plus the original one-based line number. Replaying the same retained input preserves each ID. The fixture assumes one append-only rollout per session and makes no identity claim for rewritten or forked files. It omits malformed or unbound events and rejects conflicting session metadata before writing the spool. The T3 fixture declares the native session binding directly.

Alloy reads the spool with file positions and an OTLP sending queue on its named data volume. Its [River configuration](alloy/config.txt) maps normalized clocks onto OTLP timestamps and adds observation time and identifiers as metadata. The T3 record is indexed at run completion. The low-cardinality resource attribute `plow_source` becomes a Loki stream label. High-cardinality identifiers stay in the JSON and in structured metadata. The tracked file uses a text extension for repository syntax checking and is mounted as `config.alloy`.

Run the focused projector test and the Compose fixture proof from the repository root.

```sh
node --experimental-transform-types --test collect/fixture.test.ts
bash infra/lgtm/check.sh
```

The projector uses Node 22 and [the pinned compiler bootstrap](../tooling/bend.ts), including its Bend Base, JSON and Bytes package pins. Keep or move that bootstrap and bundle when retiring the prototype tooling. The fixture path requires no SQLite, legacy collector, React dashboard, or custom MCP server. The fixture exercises the shape consumed by Alloy and Loki.


## One T3 run

Use an existing read-scoped bearer file. The adapter reads the latest bounded projection, requires exactly one strong local Codex session binding and the exact completed run, and prints one allowlisted JSON record. To stage it for Alloy, redirect stdout into a new spool using the T3 filename `t3.jsonl`. The reader supports a single run per request. Older runs that fall outside the snapshot require a paginated source adapter.

```sh
PLOW_T3_ORIGIN=https://t3.example.invalid PLOW_T3_READ_TOKEN_FILE=/private/t3-read-token \
  node collect/t3/read.ts THREAD_ID RUN_ID
```

`node --test collect/t3/read.test.ts` exercises the CLI and authentication against a synthetic HTTP origin.

## Continuous capture and retained history

The optional Compose profiles `capture-t3` and `capture-codex` each run a live
worker and an independent backfill worker. Both write immutable, allowlisted
JSONL chunks. A worker syncs each chunk and its directory before advancing
its private checkpoint. Alloy also persists its file positions and sending
queue. These are separate receipts. A producer handoff does not establish
Loki delivery.

| Input | Purpose |
| --- | --- |
| `PLOW_T3_ORIGIN`, `PLOW_T3_READ_TOKEN_FILE` | Stock T3 orchestration origin and private read-scoped bearer file |
| `PLOW_T3_NETWORK_MODE` | Docker network mode for T3 capture, default `bridge`. Set `host` when the authorized T3 service listens only on the same Linux host's IPv4 loopback. |
| `PLOW_T3_SCOPE`, `PLOW_CODEX_SCOPE` | Stable safe aliases for the configured sources |
| `PLOW_CODEX_SESSIONS`, `PLOW_CODEX_ARCHIVES` | Read-only host roots containing authorized retained Codex rollouts |

The existing Compose project stores the worker checkpoints on
`capture-state` and the normalized output under the configured private spool.
Enable only the profiles whose inputs are configured. Run one worker per
scope and lane against a given checkpoint. The production entry points also
accept `--capture live` or `--capture backfill` and a final `--once` for a single
cycle. Set `PLOW_CAPTURE_STATE`, `PLOW_CAPTURE_SPOOL` and `PLOW_CAPTURE_SCOPE`
for direct invocation, as well as `PLOW_CODEX_ROOTS` (colon-delimited) or the
T3 origin and token file inputs.

T3 uses the active shell, the archived shell RPC, bounded thread heads, and
opaque `history?view=activity` cursors. Head records preserve T3 request,
provider-start and completion clocks independently and retain status for
threads without Codex binding. A run can carry a Codex session only when
the run's provider-thread pointer resolves to one strong local native
Codex binding. The cursor covers turn items, including strongly referenced
command executions. The stock history response has no separate run ledger.
The health heartbeat records this distinction even after the turn-item
cursor is exhausted. Failed pages retain the cursor and retry behind unread work. An HTTP 400
for a saved cursor triggers a fresh head read. No collection predicate uses the Grafana
range.

Codex reads newline-complete records from active, rotated and archived
`rollout-*.jsonl` files, including gzip and Zstandard archives. Plain files resume by
identity, byte offset and a boundary fingerprint. Archive resume decodes from
the beginning and skips to the saved uncompressed offset. Replacements and
forked copies replay stable call event identities. A truncated tail stays
pending. Unsupported compressed formats are a coverage gap. Filenames and
source content stay in the private checkpoint and input roots. Historical
JSONL preserves function and custom tool call envelope clocks. Live OTLP continues independently
through the existing sanitized Tempo route.

The Activity streams use `plow_source=t3_history|codex_history|github_history`.
Alloy preserves event time in Loki when it exists. It assigns the UTC event
hour on each log and then groups resources by hour for indexing. That keeps
replays within Loki's per-stream late-arrival window even after a newer
calendar-hour partition has arrived. The configured indexes use source and hour.
GitHub rows with a null source anchor use Alloy's observation time for
indexing and retain the null timestamp in the body. Health rows are emitted
separately to `/spool/health/*.jsonl` with the common collector schema. Health
heartbeats report staged records and authorized file or thread inventory, as
available. They carry no raw errors, source URLs, file paths or credentials.

Run `node --test collect/fixture.test.ts collect/t3/read.test.ts` for source
restart, active arrivals, cursor exhaustion, failure and archive replay.
Run `bash infra/lgtm/check.sh` for a recent-first insert followed by an event
from three days earlier, then verify that both exact event times are readable.
