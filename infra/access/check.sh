set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
export PLOW_LGTM_WORKDIR=$(mktemp -d /tmp/apparent-dev-plow-access-XXXXXX)
job=${PLOW_LGTM_WORKDIR##*-}
project="plow-access-${job,,}"
export PLOW_ACCESS_IMAGE="$project:local"
export PLOW_TAILNET_ORIGIN=https://candidate.example.ts.net:19480
compose() {
  docker compose -p "$project" -f infra/lgtm/compose.yaml -f infra/access/compose.yaml "$@"
}
cleanup() {
  status=$?
  compose down --volumes > "$PLOW_LGTM_WORKDIR/cleanup.log" 2>&1
  printf 'Synthetic access check status %s. Evidence in %s\n' "$status" "$PLOW_LGTM_WORKDIR"
}
trap cleanup EXIT

node --experimental-transform-types collect/fixture.ts "$PLOW_LGTM_WORKDIR"
mkdir -m 0777 "$PLOW_LGTM_WORKDIR/access-grafana"
openssl rand -hex 24 > "$PLOW_LGTM_WORKDIR/grafana-password"
chmod 444 "$PLOW_LGTM_WORKDIR/grafana-password"

compose config --quiet
compose up -d --build --wait --wait-timeout 120
first=$(compose ps -q grafana)
[[ -z $(docker inspect --format '{{range .NetworkSettings.Ports}}{{if .}}{{.}}{{end}}{{end}}' "$first") ]]
node --test infra/access/access.test.mjs
compose up -d --no-build --wait --wait-timeout 120
[[ "$first" == "$(compose ps -q grafana)" ]]
PLOW_ACCESS_REAPPLY=1 node --test infra/access/access.test.mjs
printf 'Candidate startup and reapply retained the Grafana container, Viewer and fixture query.\n'
