set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
: "${PLOW_LGTM_WORKDIR:?Set the private runtime directory}"
: "${PLOW_TAILNET_VIEWER:?Set the allowed Tailscale login}"
: "${PLOW_TAILNET_HTTPS_PORT:?Set the dedicated Tailscale HTTPS port}"
: "${PLOW_GRAFANA_PORT:?Set the dedicated Grafana loopback port}"
node_name=$(tailscale status --json | jq -er '.Self.DNSName | rtrimstr(".")')
mode=${1:-}
case "$mode" in
  ""|--access|--restore-private) ;;
  *) exit 2 ;;
esac
export PLOW_GRAFANA_ROOT_URL="https://$node_name:$PLOW_TAILNET_HTTPS_PORT/"
export PLOW_GRAFANA_TAILNET_AUTH=true PLOW_LGTM_RESTART=unless-stopped
authority="$node_name:$PLOW_TAILNET_HTTPS_PORT"
backend="http://127.0.0.1:$PLOW_GRAFANA_PORT"
legacy_target="$backend"
access_target="unix:$PLOW_LGTM_WORKDIR/access-tailnet.sock"
accepted_access=""
if [[ -n $mode ]]; then accepted_access="$access_target"; fi
compose=(docker compose -p plow-grafana)
admin_socket=()
if [[ $mode == --access ]]; then
  export PLOW_TAILNET_ORIGIN="https://$authority"
  compose+=(-f infra/lgtm/compose.yaml -f infra/access/compose.yaml)
  admin_socket=(--unix-socket "$PLOW_LGTM_WORKDIR/access-grafana/grafana.sock")
  backend=http://localhost/app
  [[ $(curl --max-time 5 --unix-socket "${access_target#unix:}" -sS -o /dev/null -w '%{http_code}' \
      -H "X-Forwarded-Host: $authority" "$backend/api/user") == 401 ]]
fi
route=$(tailscale serve status --json)
jq -e --arg authority "$authority" --arg legacy "$legacy_target" --arg access "$accepted_access" '
  (.AllowFunnel[$authority] != true) and
  (.Web[$authority] == null or (.Web[$authority].Handlers | keys == ["/"]) and (.Web[$authority].Handlers["/"].Proxy as $target | $target == $legacy or ($access != "" and $target == $access)))
' <<< "$route" > /dev/null
umask 077
mkdir -p "$PLOW_LGTM_WORKDIR/spool"
if [[ ! -s "$PLOW_LGTM_WORKDIR/grafana-password" ]]; then
  openssl rand -hex 32 > "$PLOW_LGTM_WORKDIR/grafana-password"
  chmod 444 "$PLOW_LGTM_WORKDIR/grafana-password"
fi

if [[ $mode == --access ]]; then
  [[ $(stat -c '%u:%a' "$PLOW_LGTM_WORKDIR") == "$(id -u):700" ]]
  [[ ! -L "$PLOW_LGTM_WORKDIR/access-grafana" ]]
  mkdir -p "$PLOW_LGTM_WORKDIR/access-grafana"
  chmod 0777 "$PLOW_LGTM_WORKDIR/access-grafana"
fi
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --wait --wait-timeout 120
admin() {
  curl -fsS --max-time 15 "${admin_socket[@]}" --netrc-file <(printf 'default login admin password %s\n' "$(cat "$PLOW_LGTM_WORKDIR/grafana-password")") "$@"
}
users=$(admin "$backend/api/org/users")
if ! jq -e --arg user "$PLOW_TAILNET_VIEWER" 'any(.[]; .login == $user)' <<< "$users" > /dev/null; then
  openssl rand -hex 32 |
    jq -Rc --arg user "$PLOW_TAILNET_VIEWER" '{name:"Plow viewer",login:$user,email:$user,password:.}' |
    admin -H 'Content-Type: application/json' --data-binary @- "$backend/api/admin/users" > /dev/null
fi
viewer_id=$(admin "$backend/api/org/users" |
  jq -er --arg user "$PLOW_TAILNET_VIEWER" '.[] | select(.login == $user and .email == $user and .role == "Viewer" and .isDisabled == false) | .userId')
admin "$backend/api/users/$viewer_id" | jq -e '.isGrafanaAdmin == false and .isDisabled == false' > /dev/null
admin "$backend/api/users/$viewer_id/orgs" | jq -e 'length == 1 and .[0].role == "Viewer"' > /dev/null
serve_target="$legacy_target"
if [[ $mode == --access ]]; then serve_target="$access_target"; fi
if [[ ${PLOW_TAILNET_SUDO:-false} == true ]]; then
  sudo -n tailscale serve --bg --https="$PLOW_TAILNET_HTTPS_PORT" "$serve_target"
else
  tailscale serve --bg --https="$PLOW_TAILNET_HTTPS_PORT" "$serve_target"
fi
printf '%s\n' "$PLOW_GRAFANA_ROOT_URL"
