set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
export PLOW_LGTM_WORKDIR
PLOW_LGTM_WORKDIR=$(mktemp -d /tmp/apparent-dev-plow-lgtm-XXXXXX)
job=${PLOW_LGTM_WORKDIR##*-}
export PLOW_GRAFANA_IMAGE="plow-grafana-check-${job,,}:local"
compose() { docker compose -p "plow-lgtm-${job,,}" "$@"; }
cleanup() {
  status=$?
  if (( status != 0 )); then
    compose logs > "$PLOW_LGTM_WORKDIR/compose.log" 2>&1 || true
    tail -80 "$PLOW_LGTM_WORKDIR/compose.log" >&2
    printf 'Verification failed. Evidence: %s\n' "$PLOW_LGTM_WORKDIR" >&2
  fi
  compose down --volumes > "$PLOW_LGTM_WORKDIR/cleanup.log" 2>&1
}
trap cleanup EXIT

node --experimental-transform-types collect/fixture.ts "$PLOW_LGTM_WORKDIR"
openssl rand -hex 24 > "$PLOW_LGTM_WORKDIR/grafana-password"
chmod 444 "$PLOW_LGTM_WORKDIR/grafana-password"

compose config -q
compose run --rm --no-deps alloy validate --stability.level=public-preview /etc/alloy/config.alloy
compose up -d --build --wait --wait-timeout 90

grafana=$(compose port grafana 3000)
loki=$(compose port loki 3100)
tempo=$(compose port tempo 3200)
mimir=$(compose port mimir 9009)
alloy=$(compose port alloy 4318)
[[ $grafana == 127.0.0.1:* && $loki == 127.0.0.1:* && $tempo == 127.0.0.1:* &&
   $mimir == 127.0.0.1:* && $alloy == 127.0.0.1:* ]]
grafana_api() {
  curl -fsS --max-time 5 --user "admin:$(cat "$PLOW_LGTM_WORKDIR/grafana-password")" "http://$grafana/api/$1"
}
curl -fsS --max-time 5 "http://$grafana/public/build/plow-cream.png" > "$PLOW_LGTM_WORKDIR/wordmark.png"
cmp grafana/assets/plow-cream.png "$PLOW_LGTM_WORKDIR/wordmark.png"
grafana_api dashboards/uid/plow-run-breakdown > "$PLOW_LGTM_WORKDIR/dashboard.json"
jq -e '.meta.provisioned and (.dashboard.templating.list[0].current.value == "fixture-run") and
  any(.dashboard.panels[]; .id == 1 and .type == "table" and .targets[0].runId == "$runId")' "$PLOW_LGTM_WORKDIR/dashboard.json"
grafana_api datasources/uid/plow-agent-observability > "$PLOW_LGTM_WORKDIR/datasource.json"
jq -e '.type == "plow-agent-observability-datasource" and .jsonData.lokiTenant == "plow-fixture" and
  .jsonData.lokiUrl == "http://loki:3100"' "$PLOW_LGTM_WORKDIR/datasource.json"

query() {
  local selector='{plow_source=~"codex_history|t3"}'
  curl -fsSG --max-time 15 --retry 2 --retry-max-time 35 -H 'X-Scope-OrgID: plow-fixture' -H 'X-Loki-Response-Encoding-Flags: categorize-labels' \
    --data-urlencode "query=${1:-$selector}" \
    --data-urlencode 'start=2025-06-03T11:59:00Z' --data-urlencode 'end=2025-06-03T12:01:00Z' \
    "http://$loki/loki/api/v1/query_range"
}
received() {
  curl -fsS --max-time 5 "http://$loki/metrics" |
    awk '/^loki_distributor_lines_received_total\{format="otlp".*tenant="plow-fixture"/ { print $NF }'
}
await_lines() {
  for ((attempt=0; attempt<30; attempt++)); do
    count=$(received || true)
    if [[ $count == "$1" ]]; then return; fi
    sleep 1
  done
  printf 'Expected %s OTLP records, saw %s\n' "$1" "${count:-none}" >&2
  return 1
}

await_lines 4
expected=$(jq -csS 'sort_by(.kind, .eventId)' "$PLOW_LGTM_WORKDIR"/spool/*.jsonl)
read_history() {
  local observed
  for ((attempt=0; attempt<5; attempt++)); do
    if query > "$PLOW_LGTM_WORKDIR/loki.json" &&
      observed=$(jq -ceS '[.data.result[].values[][1] | fromjson] | sort_by(.kind, .eventId)' "$PLOW_LGTM_WORKDIR/loki.json") &&
      [[ $observed == "$expected" ]]; then return; fi
    sleep 1
  done
  printf 'Loki did not return the expected historical records after ingestion\n' >&2
  return 1
}
read_history
jq -e '
  ([.data.result[].stream.plow_source] | sort | unique) == ["codex_history", "t3"]
  and all(.data.result[].values[];
    (.[1] | fromjson) as $record |
    (.[2].structuredMetadata) as $metadata |
    ((.[0] | tonumber) == (($record.timestampMs // $record.run.completedMs) * 1000000))
    and (($metadata.observed_timestamp | tonumber) > (.[0] | tonumber))
    and ($metadata.session_id == ($record.sessionId // $record.run.sessionId))
    and ($metadata.event_id == $record.eventId)
    and ($metadata.call_id == $record.callId)
    and ($metadata.run_id == $record.run.id)
  )
' "$PLOW_LGTM_WORKDIR/loki.json"
[[ $(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://$loki/loki/api/v1/labels") == 401 ]]

query '{plow_source="t3"} | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_run" | plow_run_id="fixture-run"' |
  jq -e '[.data.result[].values[][1] | fromjson | .run.id] == ["fixture-run"]'
query '{plow_source="codex_history"} | json plow_session_id="sessionId" | plow_session_id="fixture-session"' |
  jq -e '[.data.result[].values[][1] | fromjson | .sessionId] == ["fixture-session", "fixture-session", "fixture-session"]'

jq -c --arg from 1748951940000 --arg to 1748952060000 '
  {from: $from, to: $to, queries: [(.dashboard.panels[] | select(.id == 1) | .targets[0] | .runId = "fixture-run")]}
' "$PLOW_LGTM_WORKDIR/dashboard.json" > "$PLOW_LGTM_WORKDIR/query.json"
analyze() {
  curl -fsS --max-time 15 --user "admin:$(cat "$PLOW_LGTM_WORKDIR/grafana-password")" \
    -H 'Content-Type: application/json' --data-binary @"$PLOW_LGTM_WORKDIR/query.json" "http://$grafana/api/ds/query"
}
analyze > "$PLOW_LGTM_WORKDIR/analysis.json"
jq -e '
  .results.A.status == 200
  and ([.results.A.frames[] | select(.schema.name == "intervals") | .data.values[4][]] | sort) == [null,2000]
  and ([.results.A.frames[] | select(.schema.name == "coverage") | .data.values[3][]] == [1])
' "$PLOW_LGTM_WORKDIR/analysis.json"

trace_id=11111111111111111111111111111111
now_ns=$(date +%s)000000000
end_ns=$((now_ns + 100000000))
jq -nc --arg trace "$trace_id" --arg start "$now_ns" --arg end "$end_ns" '
  {resourceSpans:[{resource:{attributes:[{key:"private",value:{stringValue:"fixture-live-canary"}}]},
    scopeSpans:[{scope:{name:"fixture-live-canary"},spans:[{
      traceId:$trace, spanId:"2222222222222222", name:"codex.sampling",
      startTimeUnixNano:$start, endTimeUnixNano:$end,
      attributes:[{key:"conversation.id",value:{stringValue:"11111111-1111-1111-1111-111111111111"}},
        {key:"private",value:{stringValue:"fixture-live-canary"}}],
      events:[{timeUnixNano:$end,name:"fixture-live-canary",
        attributes:[{key:"private",value:{stringValue:"fixture-live-canary"}}]}]
    }]}]}]}
' > "$PLOW_LGTM_WORKDIR/trace-request.json"
curl -fsS --retry 8 --retry-connrefused --max-time 5 -H 'Content-Type: application/json' \
  --data-binary @"$PLOW_LGTM_WORKDIR/trace-request.json" "http://$alloy/v1/traces" > "$PLOW_LGTM_WORKDIR/trace-receipt.json"
await_query() {
  local url=$1 predicate=$2 output=$3
  for ((attempt=0; attempt<30; attempt++)); do
    if curl -fsS --max-time 5 "$url" > "$output" 2>/dev/null &&
      jq -e "$predicate" "$output" > /dev/null; then return; fi
    sleep 1
  done
  printf 'Backend query did not produce the expected fixture result: %s\n' "$url" >&2
  return 1
}
await_query "http://$tempo/api/traces/$trace_id" 'any(.. | objects; .name? == "codex.sampling")' \
  "$PLOW_LGTM_WORKDIR/tempo.json"
if grep -Fq fixture-live-canary "$PLOW_LGTM_WORKDIR/tempo.json"; then
  printf 'Private fixture marker reached Tempo\n' >&2
  exit 1
fi
await_query "http://$mimir/prometheus/api/v1/query?query=node_memory_MemTotal_bytes" \
  'any(.data.result[]; .metric.plow_host == "loopback-fixture" and (.value[1] | tonumber) > 0)' \
  "$PLOW_LGTM_WORKDIR/mimir.json"

before=$(compose ps -q)
compose up -d --wait --wait-timeout 90
[[ $(compose ps -q) == "$before" ]]
compose up -d --no-deps --force-recreate --wait --wait-timeout 90 alloy
head -n 1 "$PLOW_LGTM_WORKDIR/spool/codex.jsonl" >> "$PLOW_LGTM_WORKDIR/spool/codex.jsonl"
await_lines 5
query > "$PLOW_LGTM_WORKDIR/loki-replay.json"
replayed=$(jq -ceS '[.data.result[].values[][1] | fromjson] | unique | sort_by(.kind, .eventId)' "$PLOW_LGTM_WORKDIR/loki-replay.json")
[[ $replayed == "$expected" ]]

printf 'Verified redacted OTLP records, persisted positions, replay identity and Grafana provisioning. Evidence: %s\n' "$PLOW_LGTM_WORKDIR"

analyze > "$PLOW_LGTM_WORKDIR/analysis-replay.json"
diff -u <(jq -S . "$PLOW_LGTM_WORKDIR/analysis.json") <(jq -S . "$PLOW_LGTM_WORKDIR/analysis-replay.json")

grafana_post() {
  curl -fsS --max-time 10 --user "admin:$(cat "$PLOW_LGTM_WORKDIR/grafana-password")" \
    -H 'Content-Type: application/json' --data "$2" "http://$grafana/api/$1"
}
account=$(grafana_post serviceaccounts '{"name":"plow-fixture-mcp","role":"Viewer"}' | jq -er .id)
(umask 077; grafana_post "serviceaccounts/$account/tokens" '{"name":"verification","secondsToLive":300}' |
  jq -er .key > "$PLOW_LGTM_WORKDIR/mcp-token")
node verify/grafana-mcp.ts "http://$grafana" "$PLOW_LGTM_WORKDIR/mcp-token" \
  "$PLOW_LGTM_WORKDIR/query.json" "$PLOW_LGTM_WORKDIR/analysis.json" "$PLOW_LGTM_WORKDIR/mcp.json"
unlink "$PLOW_LGTM_WORKDIR/mcp-token"
printf 'Verified Grafana analysis, replay, Tempo traces, Mimir metrics, and Grafana MCP. Evidence: %s\n' "$PLOW_LGTM_WORKDIR"

mkdir -p "$PLOW_LGTM_WORKDIR/spool/t3"
end_ms=$(( $(date +%s) * 1000 - 1000 ))
start_ms=$(( end_ms - 86400000 ))
old_ms=$(( end_ms - 3 * 86400000 ))
jq -nc --argjson end "$end_ms" '
  {kind:"t3_coverage",eventId:"activity-checkpoint",timestampMs:$end,observedMs:$end,status:"idle"}
' > "$PLOW_LGTM_WORKDIR/spool/t3/current.jsonl"
activity_selector='{plow_source="t3_history"}'
activity_loki() {
  curl -fsSG --max-time 6 -H 'X-Scope-OrgID: plow-fixture' -H 'X-Loki-Response-Encoding-Flags: categorize-labels' \
    --data-urlencode "query=$activity_selector" --data-urlencode "start=${old_ms}000000" \
    --data-urlencode "end=$((end_ms + 1))000000" "http://$loki/loki/api/v1/query_range"
}
await_activity() {
  local predicate=$1 file=$2
  for ((attempt=0; attempt<15; attempt++)); do
    if activity_loki > "$file" && jq -e "$predicate" "$file" >/dev/null; then return; fi
    sleep 1
  done
  return 1
}
await_activity '([.data.result[].values[]]|length)==1' "$PLOW_LGTM_WORKDIR/activity-current.json"
jq -nc --argjson old "$old_ms" --argjson end "$end_ms" '
  def run($id;$thread;$r;$s;$e): {kind:"t3_activity_run",eventId:$id,timestampMs:$e,revisionMs:$e,observedMs:$end,
    run:{id:$id,threadId:$thread,sessionId:"",requestedMs:$r,startedMs:$s,completedMs:$e}};
  run("old";"other";$old - 9000;$old - 5000;$old),
  run("recent";"thread-a";$end - 3604000;$end - 3602000;$end - 3600000)
' > "$PLOW_LGTM_WORKDIR/activity-runs.jsonl"
cp "$PLOW_LGTM_WORKDIR/activity-runs.jsonl" "$PLOW_LGTM_WORKDIR/spool/t3/range.jsonl"
await_activity '([.data.result[].values[]]|length)==3' "$PLOW_LGTM_WORKDIR/activity-loki.json"
jq -e '([.data.result[].values[]]|length) == 3 and (.data.result|length)==3 and
  all(.data.result[]; .stream.plow_hour as $hour | all(.values[]; (.[0]|tonumber/3600000000000|floor|tostring)==$hour))' \
  "$PLOW_LGTM_WORKDIR/activity-loki.json"
grafana_api dashboards/uid/plow-activity > "$PLOW_LGTM_WORKDIR/activity-dashboard.json"
jq -c --arg from "$start_ms" --arg to "$end_ms" '
  {from:$from,to:$to,queries:[.dashboard.panels[].targets[]? | select(.activityView) |
    . + {refId:.activityView,range:"24h",operation:"all"}]}
' "$PLOW_LGTM_WORKDIR/activity-dashboard.json" > "$PLOW_LGTM_WORKDIR/activity-query.json"
activity_query() {
  grafana_post ds/query "$(cat "$PLOW_LGTM_WORKDIR/activity-query.json")"
}
activity_query > "$PLOW_LGTM_WORKDIR/activity.json"
jq -e 'all(.results[]; .status==200) and
  ([.results.share.frames[0].data.values[1][]] | map(select(. == null)) | length) == 5 and
  ([.results.timeline.frames[].schema.name] == ["thread-a"])' "$PLOW_LGTM_WORKDIR/activity.json"
umask 077
grafana_post "serviceaccounts/$account/tokens" '{"name":"activity-verification","secondsToLive":300}' |
  jq -er .key > "$PLOW_LGTM_WORKDIR/mcp-token"
node verify/grafana-mcp.ts "http://$grafana" "$PLOW_LGTM_WORKDIR/mcp-token" \
  "$PLOW_LGTM_WORKDIR/activity-query.json" "$PLOW_LGTM_WORKDIR/activity.json" "$PLOW_LGTM_WORKDIR/activity-mcp.json"
unlink "$PLOW_LGTM_WORKDIR/mcp-token"
printf 'Verified Activity frames, source-hour ordering, and Grafana MCP. Evidence: %s\n' "$PLOW_LGTM_WORKDIR"
