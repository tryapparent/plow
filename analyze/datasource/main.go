package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	grafanads "github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
)

const (
	pluginID     = "plow-agent-observability-datasource"
	runLimit     = 100
	eventLimit   = 2000
	maxQueries   = 8
	maxRange     = 7 * 24 * time.Hour
	queryTimeout = 12 * time.Second
	ioTimeout    = 4 * time.Second
)

var (
	identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	historyID  = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9:_-]|%[0-9A-Fa-f]{2})*$`)
	tenantID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	minTime    = time.Unix(0, 0)
	maxTime    = time.Unix(0, 1<<63-2)
)

type datasource struct {
	loki   lokiClient
	policy string
}

func newDatasource(_ context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	var config struct {
		LokiURL    string `json:"lokiUrl"`
		LokiTenant string `json:"lokiTenant"`
	}
	if err := json.Unmarshal(settings.JSONData, &config); err != nil {
		return nil, errors.New("Invalid Plow datasource settings")
	}

	endpoint, err := url.Parse(config.LokiURL)
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Hostname() == "" ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" {
		return nil, errors.New("Configure lokiUrl as an HTTP or HTTPS base URL")
	}
	if !tenantID.MatchString(config.LokiTenant) {
		return nil, errors.New("Configure lokiTenant as a single tenant ID")
	}
	token := settings.DecryptedSecureJSONData["lokiBearerToken"]
	if len(token) > 4096 || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("Invalid Loki bearer token setting")
	}
	policy := os.Getenv("PLOW_POLICY_COMMAND")
	if !filepath.IsAbs(policy) {
		return nil, errors.New("Set PLOW_POLICY_COMMAND to an absolute executable path")
	}

	return &datasource{
		loki: lokiClient{
			endpoint: endpoint.JoinPath("loki", "api", "v1", "query_range"),
			tenant:   config.LokiTenant,
			token:    token,
			http: &http.Client{
				Timeout: ioTimeout,
				CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
					return http.ErrUseLastResponse
				},
			},
		},
		policy: policy,
	}, nil
}

func (ds *datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	if len(req.Queries) > maxQueries {
		return nil, errors.New("Plow accepts at most 8 queries per request")
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	response := backend.NewQueryDataResponse()
	for _, query := range req.Queries {
		response.Responses[query.RefID] = ds.query(ctx, query)
	}
	return response, nil
}

func (ds *datasource) query(ctx context.Context, query backend.DataQuery) backend.DataResponse {
	var model struct {
		RunID        string `json:"runId"`
		History      string `json:"history"`
		ActivityView string `json:"activityView"`
		Range        string `json:"range"`
		Operation    string `json:"operation"`
	}
	if len(query.JSON) > 8<<10 || json.Unmarshal(query.JSON, &model) != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Invalid Plow query")
	}
	validID := identifier.MatchString(model.RunID)
	if model.History == "1" {
		validID = len(model.RunID) <= 512 && historyID.MatchString(model.RunID)
	}
	if model.ActivityView == "" && !validID {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Enter a valid run ID")
	}

	window := query.TimeRange
	if window.From.Before(minTime) || window.To.After(maxTime) || !window.To.After(window.From) || window.To.Sub(window.From) > maxRange {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Select a valid time range of at most 7 days")
	}

	if model.ActivityView != "" {
		return ds.activity(ctx, window.To, model.ActivityView, model.Range, model.Operation)
	}

	var run runRecord
	var failure *backend.DataResponse
	if model.History == "1" {
		run, failure = ds.readHistoryRun(ctx, window, model.RunID)
	} else {
		run, failure = ds.loki.readRun(ctx, window, model.RunID)
	}
	if failure != nil {
		return *failure
	}
	events, gaps, failure := ds.loki.readEvents(ctx, window, run.SessionID)
	if failure != nil {
		return *failure
	}
	if time.UnixMilli(*run.StartedMS).Before(window.From) || time.UnixMilli(*run.CompletedMS).After(window.To) {
		gaps = append(gaps, "Selected time range excludes part of the run")
	}

	output, failure := executePolicy(ctx, ds.policy, policyInput{Run: run, Events: events})
	if failure != nil {
		return *failure
	}
	return render(output, gaps)
}

func (ds *datasource) activity(ctx context.Context, cutoff time.Time, view, period, operation string) backend.DataResponse {
	if period != "24h" && period != "7d" || len(operation) > 128 {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Select Last 24h or Last 7 days")
	}
	window := backend.TimeRange{From: cutoff.Add(-maxRange - 24*time.Hour), To: cutoff}
	type sourceResult struct {
		source  string
		lines   []string
		partial bool
		failure *backend.DataResponse
	}
	selectors := []struct {
		source string
		filter string
		latest bool
	}{
		{"t3", "", false},
		{"t3_history", ` | json plow_kind="kind" | plow_kind=~"t3_activity_run|t3_pr_link|t3_ci_link|confirmed_delay"`, false},
		{"t3_history", ` | json plow_kind="kind" | plow_kind="operation"`, false},
		{"t3_history", ` | json plow_kind="kind" | plow_kind="t3_coverage"`, true},
		{"github_history", ` | json plow_kind="kind" | plow_kind=~"github_actions_attempt|github_actions_job"`, false},
		{"github_history", ` | json plow_kind="kind" | plow_kind="github_coverage"`, true},
		{"codex_history", ` | json plow_kind="kind" | plow_kind="codex_coverage"`, true},
	}
	results := make(chan sourceResult, len(selectors))
	for _, item := range selectors {
		go func() {
			selector := `{plow_source="` + item.source + `"}` + item.filter
			limit := 5000
			if item.latest {
				limit = 32
			}
			lines, gaps, failure := ds.loki.readDirection(ctx, window, selector, item.source, limit, item.latest)
			results <- sourceResult{item.source, lines, len(gaps) != 0, failure}
		}()
	}
	records := make(map[string][]string, len(selectors))
	partial := false
	for range selectors {
		result := <-results
		if result.failure != nil {
			return *result.failure
		}
		records[result.source] = append(records[result.source], result.lines...)
		partial = partial || result.partial
	}
	raw, failure := runPolicy(ctx, ds.policy, map[string]any{
		"to": cutoff.UnixMilli(), "view": view, "range": period, "operation": operation, "records": records, "partial": partial,
	})
	if failure != nil {
		return *failure
	}
	var report activityOutput
	if json.Unmarshal(raw, &report) != nil || report.From == 0 {
		return *policyFailure(backend.StatusInternal, "Policy executable returned an invalid Activity result")
	}
	frames := renderActivity(report, view)
	if frames == nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Unknown Activity view")
	}
	return backend.DataResponse{Frames: frames}
}

func (ds *datasource) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	info, err := os.Stat(ds.policy)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: "Configured policy executable is unavailable"}, nil
	}
	now := time.Now()
	_, _, failure := ds.loki.read(ctx, backend.TimeRange{From: now.Add(-time.Minute), To: now}, t3Selector, "t3", 1)
	if failure != nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: failure.Error.Error()}, nil
	}
	return &backend.CheckHealthResult{Status: backend.HealthStatusOk, Message: "Loki is reachable and the policy executable exists"}, nil
}

func main() {
	if err := grafanads.Manage(pluginID, newDatasource, grafanads.ManageOpts{}); err != nil {
		log.Fatal(err)
	}
}
