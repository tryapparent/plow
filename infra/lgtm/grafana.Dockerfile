FROM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS plugin
WORKDIR /src
COPY analyze/datasource/go.mod analyze/datasource/go.sum ./
RUN go mod download
COPY analyze/datasource/ ./
RUN CGO_ENABLED=0 go test -mod=readonly ./...
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o "/out/gpx_plow_linux_$(go env GOARCH)" .

FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS policy
WORKDIR /src
COPY tooling/bend.ts tooling/bend.ts
COPY analyze/policy/main.ts analyze/policy/*.bend analyze/policy/
RUN mkdir -p /out /dashboards && node analyze/policy/main.ts --compile /out
COPY grafana/dashboards/run-breakdown.json /src/dashboards.json
RUN node -e 'const fs = require("node:fs"); for (const d of require("/src/dashboards.json")) fs.writeFileSync("/dashboards/" + d.uid + ".json", JSON.stringify(d))'

FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS capture
WORKDIR /opt/plow
COPY tooling/bend.ts tooling/bend.ts
COPY collect/fixture.ts collect/*.bend collect/
COPY collect/t3/read.ts collect/t3/read.ts
RUN mkdir /opt/plow/policy && node --input-type=module -e 'import { buildPolicies } from "./tooling/bend.ts"; await buildPolicies("/opt/plow/policy", [[new URL("./collect/project.bend", import.meta.url), "collect.mjs"], [new URL("./collect/capture.bend", import.meta.url), "capture.mjs"]])'
ENV PLOW_COLLECT_MODULE=/opt/plow/policy/collect.mjs \
    PLOW_CAPTURE_MODULE=/opt/plow/policy/capture.mjs

FROM grafana/grafana:12.3.0-ubuntu@sha256:cee936306135e1925ab21dffa16f8a411535d16ab086bef2309339a8e74d62df
COPY --from=policy /usr/local/bin/node /usr/local/bin/node
COPY --from=plugin /out/ /opt/plow/plugins/plow-agent-observability-datasource/
COPY analyze/datasource/plugin.json analyze/datasource/module.js /opt/plow/plugins/plow-agent-observability-datasource/
COPY grafana/assets/plow-cream.png /usr/share/grafana/public/build/plow-cream.png
COPY --from=policy /out/ /opt/plow/policy/
COPY --from=policy /dashboards/ /opt/plow/dashboards/
COPY grafana/dashboards/codex-trace*.json grafana/dashboards/collection-health.json /opt/plow/dashboards/
COPY analyze/policy/main.ts /opt/plow/policy/main.ts
COPY --chmod=0755 infra/lgtm/policy.sh /opt/plow/policy/analyze
ENV GF_PATHS_PLUGINS=/opt/plow/plugins \
    PLOW_POLICY_COMMAND=/opt/plow/policy/analyze \
    PLOW_POLICY_MODULE=/opt/plow/policy/run.mjs \
    PLOW_ACTIVITY_MODULE=/opt/plow/policy/activity.mjs
