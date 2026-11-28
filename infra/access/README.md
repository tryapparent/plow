# Plow Grafana on Cloudflare Access

The existing Cloudflare Access application protects `https://plow.tryapparent.com/app/` and its dashboard, asset and API paths. Its Google identity provider and policies stay in place. The existing `/app/mcp` rule retains precedence. The gateway also serves the existing Tailscale endpoint, including redirects from old dashboard links to the `/app/` subpath.

Cloudflare Tunnel checks the Access token before forwarding it. The gateway verifies the signed assertion again, including its issuer, audience, expiry and allowed email. It removes caller-provided identity and authentication headers and forwards only the configured Grafana Viewer identity. Grafana listens on a Unix socket inside the private runtime directory. The public ingress listener is IPv4 loopback and the Tailscale handler connects through its own Unix socket. Grafana signup and anonymous access remain disabled.

## Private runtime inputs

Use the existing persistent Grafana directory and Tailscale port inputs from the [deployment guide](../lgtm/README.md). Set the additional gateway inputs in a mode-0600 service environment file.

| Input | Purpose |
| --- | --- |
| `PLOW_ACCESS_TEAM`, `PLOW_ACCESS_AUDIENCE` | Existing Cloudflare Access team and application audience |
| `PLOW_ACCESS_EMAIL` | Exact email from the authorized Google identity |
| `PLOW_TAILNET_VIEWER`, `PLOW_TAILNET_ORIGIN` | Existing Tailscale Viewer and its HTTPS origin |
| `PLOW_ACCESS_PORT` | Dedicated unused loopback port, default 15583 |
| `PLOW_LGTM_WORKDIR` | Existing owner-only persistent Grafana directory |

Cloudflare operations additionally read `PLOW_CF_ACCOUNT`, `PLOW_CF_ZONE`, `PLOW_CF_TUNNEL`, `PLOW_CF_ACCESS_APP`, `PLOW_CF_TOKEN_FILE`, and `PLOW_CF_RECEIPT`. Use a private file holding a credential scoped to the existing account and zone with Tunnel Edit, Access Apps and Policies Read, Access Identity Providers Read and Workers Routes Read. Keep the rollback receipt in persistent private storage. The gateway service needs no Cloudflare API credential.

## Verify and apply

1. Install the gateway dependencies with `npm ci --prefix infra/access --ignore-scripts`. Run `GOMAXPROCS=2 bash infra/access/check.sh` for the isolated authentication and Compose convergence proof.
2. Run `node infra/access/cloudflare.mjs status` with the private operator inputs. Check that the exact Access application protects both `/app` and `/app/*`, Google is enabled, and ingress matches the recorded legacy shape.
3. Stage the verified release and private gateway environment at the paths in [the user service](plow-access.service.txt). Install the tracked unit as `plow-access.service` and start it, then run `bash infra/lgtm/deploy.sh --access` from the same release. Check the existing Tailscale Viewer and a known run before changing Cloudflare routing.
4. Run `node infra/access/cloudflare.mjs apply`. It saves the original ingress, checks route read-back and compares signed-out edge behavior. Open the protected application with the existing Google account and verify Viewer access, a dashboard and one data query.
5. To revert the domain cutover, run `node infra/access/cloudflare.mjs rollback` with the same receipt and verify the legacy ingress. Run `bash infra/lgtm/deploy.sh --restore-private` to restore the original Tailscale backend. Verify its Viewer access before stopping the gateway.

Grafana's protected endpoint is `/app/`. The root marketing site and the legacy MCP endpoint are outside this change. The synthetic fixture verifies origin authentication and rejection; the Google sign-in check requires the real authorized identity at the Cloudflare edge.
