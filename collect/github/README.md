# GitHub evidence collection

Run the Node 22.18+ producer with a fine-grained token or an externally rotated installation token scoped to the configured repositories. Grant **Pull requests: read** and **Actions: read**. The producer issues authenticated GETs to the fixed GitHub API origin. The optional loopback HTTP origin is for synthetic verification. Requests never follow redirects or API-supplied URLs. Link headers supply page numbers only.

| Environment input | Value |
| --- | --- |
| PLOW_GITHUB_REPOSITORIES | Required comma-separated alias=owner/repo pairs. Up to 16 unique repositories and aliases. Repository is normalized to lowercase. Aliases start with a lowercase letter or digit and may contain up to 48 lowercase letters, digits, underscores or hyphens. |
| PLOW_GITHUB_READ_TOKEN_FILE | Required private regular file, mode 0400 or 0600, at most 4 KiB. The producer reopens it each cycle. Replace it through the credential provider ahead of expiry. |
| PLOW_GITHUB_ACTIONS_SINCE | Required historical Actions floor as a UTC timestamp such as 2025-01-01T00:00:00Z. This inclusive bound applies to reconciliation as well. PR backfill covers the visible list. Use a fresh state root when intentionally changing the floor. |
| PLOW_GITHUB_STATE | Private durable state, default /state/github. Contains checkpoint, write-ahead batch, staged IDs and terminal receipts. |
| PLOW_SPOOL | Private shared spool root, default /spool. Keep its github subdirectory mode 0700. Configure ownership for this producer to write to the shared health subdirectory as well. |
| PLOW_GITHUB_JOB_NAMES | Optional JSON array of up to 512 reviewed names. Defaults to verify, build, test, lint, release and checks. Unapproved names become Other jobs. Keep the list stable with existing terminal receipts. |
| PLOW_GITHUB_MAX_STEPS | Optional work budget, default 40 operations per cycle, range 1–256. |
| PLOW_GITHUB_MAX_REQUESTS | Optional request budget, default 160 per cycle, range 24–512. |
| PLOW_BEND_BUNDLE | Path to the pinned compiler bundle produced by npm run hooks:install. Mount read-only in the runtime for offline compilation. |
| PLOW_GITHUB_ORIGIN | Defaults to https://api.github.com. The only override allowed is plain HTTP on 127.0.0.1. |

Keep one writer per state root and use distinct aliases across instances. Pre-create state and spool directories with private permissions. Use the tracked entry point from a read-only checkout. Mount state and spool writable by the runtime user. Mount the compiler and credential read-only.

```sh
flock -n -F "$PLOW_GITHUB_STATE/writer.lock" node collect/github/main.ts
```

Run with `--once` for one bounded cycle. The continuous process yields 15 seconds between cycles. Requests have an 8 MiB body cap, a 10-second timeout and a two-minute cycle deadline. Transient failures retain progress and respect GitHub retry/reset hints.

## Inventory and checkpoints

- PR history starts at the last ascending creation page and walks backward. Recent additions append at the tail. Each page verifies its boundary against the newer page and restarts discovery when the boundary moves. Live PRs independently scan recent updates with a delayed upper watermark and a two-minute overlap.
- Actions live rechecks a rolling day for recent reruns and uses its last successful upper watermark with overlap to bridge a longer gap. Historical Actions scans newest-first in disjoint creation windows of up to seven days. A result at GitHub's 1,000-result ceiling splits the window, newer half first. A capped one-second window remains a coverage gap while older windows drain. Action sweeps renew six hours after inventory exhaustion to discover reruns of older runs within the configured floor. GitHub's creation query does not expose a global rerun update cursor.
- Each queued run drains exact attempts from latest through first. The producer compares exact attempt metadata around a bounded, paginated job inventory. A job without an attempt field binds through its exact-attempt endpoint only when run ID and SHA match. A terminal attempt receives a durable receipt after staging evidence from its terminal job inventory. Active, unreadable or capped attempts remain in the durable retry backlog. Retries share the cycle's request budget and do not block fresh inventory. HTTP 404 or 410 remains unavailable, including when GitHub masks authorization or an item expired. GitHub's unobservable retention limit remains visible even when the listed inventory exhausts.
- Bend2 constructs the entity identity and canonical allowlisted revision. The filesystem adapter hashes the canonical body and publishes immutable batches through a durable outbox. It syncs evidence before recording staged IDs and advancing the checkpoint. A restart can replay the same batch. Source replay contributes no new batch for previously staged revisions. Preserve staged IDs and terminal receipts when rotating spool files after downstream acknowledgement. Downstream consumers also deduplicate by event ID, since resetting Alloy positions can replay a file. Staging measures producer handoff only.

## Evidence and health contract

Immutable batches land in `/spool/github/*.jsonl`. Each JSON object has `kind`, `eventId`, `repository`, `observedMs` and `timestampMs`. Treat the ID as opaque. It combines a SHA-256 digest of the canonical revision and the entity identity. Typed identity fields identify the entity across revisions. All clocks are UTC Unix milliseconds. The source anchor `timestampMs` can be null. `observedMs` is the collection clock at staging.

| Kind | Fields and meaning |
| --- | --- |
| github_pr | Decimal string `prNumber`, open/closed/merged `status`, nullable full `headSha` and `mergeSha`, `openedMs`, `mergedMs`, `updatedMs`. Merge SHA requires merge time because GitHub can expose a test merge SHA. Anchor is merge when observed, otherwise opening. |
| github_actions_attempt | Decimal strings `runId`, `attempt`, nullable decimal `workflowId`, full `headSha`, nullable `prNumber`, `status` and `conclusion`. PR linkage requires one explicit association with matching base repository identity. `createdMs` is measured for the first attempt only. `startedMs` is measured for the first attempt if consistent with job start. `completedMs` is null because the endpoint lacks exact completion. `updatedMs` carries GitHub's mutable update clock. `lastJobCompletedMs` is a lower bound on terminal attempt completion. `jobCount` and `jobsComplete` describe observed inventory. Anchor is validated start or creation for the first attempt and earliest measured job start for reruns. |
| github_actions_job | Decimal strings `runId`, `attempt`, `jobId`, full `headSha`, reviewed `jobName`, nullable `status`, `conclusion`, `createdMs`, `startedMs`, `completedMs`. Start and end require worker allocation and ordered source values. Anchor uses completion, start or creation in that order. |
| github_coverage | `lane`, `status`, `availability` (available, partial, unavailable or unknown), nullable `gapCode`, `windowStartMs`, `windowEndMs`, `remainingThroughMs` and `page`, count `pendingAttempts`, nullable `runId` and `attempt`. Lanes are pulls_live, pulls_backfill, actions_live, actions_backfill and actions_retention. Window exhaustion refers to an enumerated time window. Lane completion additionally requires drained pending attempts and no detected scan gap. Retention gaps are visible independently. |

Records omit PR content, actors, commit messages, ref names, raw job names, runner names, steps and logs. Release evidence awaits an explicit delivery mapping. This collector leaves publication, shipping and verified external access unknown.

Health uses `/spool/health/github-<alias>-<unique>.jsonl` with `kind=collector_health`, `schemaVersion=1`, `collector=github`, configured `scope`, `lane=live|backfill` and `status=working|idle|retrying|blocked|complete`. Both lanes emit after each cycle, including rate-limit backoff and after backfill catches up. `observedMs` is the heartbeat clock. `lastSuccessMs` is the latest successful source checkpoint in that lane. `newestSourceMs` and `oldestScannedMs` preserve known source clocks and scan bounds. `scannedUnits`, `eligibleUnits` and `ingestedRecords` stay null because these lanes mix pages, windows and attempts and the producer cannot see Loki acknowledgements.

## Compose deployment

The optional [Compose definition](../../infra/lgtm/github.compose.yaml) runs the same CLI with the writer lock and a private persistent state directory. Set the repository and Actions floor inputs above. From the repository root, set these deployment inputs.

```sh
export PLOW_LGTM_WORKDIR=/private/plow/runtime
export PLOW_GITHUB_CREDENTIAL_DIR=/private/plow/github-credentials
export PLOW_BEND_BUNDLE=/private/plow/verified-compiler
export PLOW_GITHUB_COLLECTOR_USER=0:0
export COMPOSE_FILE="$PWD/compose.yaml:$PWD/infra/lgtm/github.compose.yaml"
install -d -m 0700 "$PLOW_LGTM_WORKDIR/github-state" "$PLOW_LGTM_WORKDIR/spool"
docker compose -p plow-grafana up -d github-collector
```

Write the scoped credential to `github-read` in `PLOW_GITHUB_CREDENTIAL_DIR` with mode 0400 or 0600. Set the service UID and GID as seen inside the container. On Clanker's rootless Docker, `0:0` maps to the host account that owns the private runtime. The read-only directory bind lets reruns see an atomically replaced credential. Use the same overlay and persistent paths whenever reapplying the stack. For a bounded check with an isolated state directory, use `docker compose run --rm github-collector --once`.

The [common Alloy configuration](../alloy/config.txt) reads the GitHub spool and indexes records by source time when present, partitioned by UTC hour for late-arriving history. Records without a source anchor use Alloy’s observation time. Both producer clocks remain in each record. A separate receiver sends health reports to the [Collection Health dashboard](../../grafana/collection-health.md). [Alloy filelog settings](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.receiver.filelog/) · [Loki ordering limits](https://grafana.com/docs/loki/latest/configure/)

## Verification

```sh
npm ci --ignore-scripts
npm run hooks:install
node --test collect/github/history.test.ts
npm run verify -- collect
```

The CLI test restarts independent Node processes over the same private spool and checkpoint and reads a synthetic loopback API. Set PLOW_GITHUB_KEEP_PROOF=1 with the direct test command to retain the generated synthetic proof in a private temporary directory.
