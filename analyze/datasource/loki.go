package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const (
	t3Selector       = `{plow_source="t3"}`
	historySelector  = `{plow_source="codex_history"}`
	maxResponseBytes = 4 << 20
	maxLineBytes     = 16 << 10
)

type lokiClient struct {
	endpoint *url.URL
	tenant   string
	token    string
	http     *http.Client
}

func (l lokiClient) readRun(ctx context.Context, window backend.TimeRange, id string) (runRecord, *backend.DataResponse) {
	query := t3Selector + ` | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_run" | plow_run_id=` + strconv.Quote(id)
	lines, gaps, failure := l.read(ctx, window, query, "t3", runLimit)
	if failure != nil {
		return runRecord{}, failure
	}
	if len(gaps) != 0 {
		return runRecord{}, lokiFailure(backend.StatusBadGateway, "Loki run lookup is incomplete. Narrow the time range or check Loki")
	}

	var run runRecord
	for _, line := range lines {
		var record struct {
			Kind string    `json:"kind"`
			Run  runRecord `json:"run"`
		}
		if json.Unmarshal([]byte(line), &record) != nil || record.Kind != "t3_run" ||
			record.Run.ID != id || len(record.Run.ThreadID) > 128 ||
			!identifier.MatchString(record.Run.SessionID) || record.Run.StartedMS == nil || record.Run.CompletedMS == nil {
			return runRecord{}, lokiFailure(backend.StatusBadGateway, "Loki returned a malformed run record")
		}
		if run.ID != "" && (run.ThreadID != record.Run.ThreadID || run.SessionID != record.Run.SessionID ||
			*run.StartedMS != *record.Run.StartedMS || *run.CompletedMS != *record.Run.CompletedMS) {
			return runRecord{}, lokiFailure(backend.Status(http.StatusConflict), "Loki returned conflicting records for this run ID")
		}
		run = record.Run
	}
	if run.ID == "" {
		return runRecord{}, lokiFailure(backend.StatusNotFound, "Run ID was not found in the selected time range")
	}
	return run, nil
}

func (l lokiClient) readEvents(ctx context.Context, window backend.TimeRange, session string) ([]eventRecord, []string, *backend.DataResponse) {
	query := historySelector + ` | json plow_session_id="sessionId" | plow_session_id=` + strconv.Quote(session)
	lines, gaps, failure := l.read(ctx, window, query, "codex_history", eventLimit)
	if failure != nil {
		return nil, nil, failure
	}

	events := make([]eventRecord, 0, len(lines))
	malformed := false
	for _, line := range lines {
		var event eventRecord
		if json.Unmarshal([]byte(line), &event) != nil || event.SessionID != session || event.TimestampMS == nil ||
			len(event.EventID) > 128 || len(event.CallID) > 128 || len(event.Kind) > 32 {
			malformed = true
			continue
		}
		events = append(events, event)
	}
	if malformed {
		gaps = append(gaps, "Loki returned malformed session events")
	}
	return events, gaps, nil
}

func (l lokiClient) read(ctx context.Context, window backend.TimeRange, query, source string, limit int) ([]string, []string, *backend.DataResponse) {
	return l.readDirection(ctx, window, query, source, limit, false)
}

func (l lokiClient) readDirection(ctx context.Context, window backend.TimeRange, query, source string, limit int, latest bool) ([]string, []string, *backend.DataResponse) {
	endpoint := *l.endpoint
	params := endpoint.Query()
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(window.From.UnixNano(), 10))
	params.Set("end", strconv.FormatInt(window.To.UnixNano()+1, 10))
	if latest {
		params.Set("direction", "backward")
	} else {
		params.Set("direction", "forward")
	}
	params.Set("limit", strconv.Itoa(limit))
	endpoint.RawQuery = params.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, nil, lokiFailure(backend.StatusInternal, "Could not build the Loki request")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Loki-Response-Encoding-Flags", "categorize-labels")
	request.Header.Set("X-Scope-OrgID", l.tenant)
	if l.token != "" {
		request.Header.Set("Authorization", "Bearer "+l.token)
	}
	response, err := l.http.Do(request)
	if err != nil {
		return nil, nil, lokiTransportFailure(err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, nil, lokiFailure(backend.StatusForbidden, "Loki denied access. Check the configured tenant and credentials")
	case http.StatusTooManyRequests:
		return nil, nil, lokiFailure(backend.StatusTooManyRequests, "Loki rate limited the request")
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		return nil, nil, lokiFailure(backend.StatusTimeout, "Loki query timed out")
	default:
		return nil, nil, lokiFailure(backend.StatusBadGateway, "Loki returned HTTP "+strconv.Itoa(response.StatusCode))
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, nil, lokiTransportFailure(err)
	}
	if len(body) > maxResponseBytes {
		return nil, nil, lokiFailure(backend.StatusBadGateway, "Loki response exceeded 4 MiB. Narrow the time range")
	}
	var payload struct {
		Status   string   `json:"status"`
		Warnings []string `json:"warnings"`
		Data     struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Stream map[string]string   `json:"stream"`
				Values [][]json.RawMessage `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Status != "success" || payload.Data.ResultType != "streams" || payload.Data.Result == nil {
		return nil, nil, lokiFailure(backend.StatusBadGateway, "Loki returned an invalid stream response")
	}

	var lines, gaps []string
	for _, stream := range payload.Data.Result {
		if stream.Stream["plow_source"] != source || stream.Values == nil {
			return nil, nil, lokiFailure(backend.StatusBadGateway, "Loki returned an unexpected stream")
		}
		for _, value := range stream.Values {
			if len(lines) == limit {
				return nil, nil, lokiFailure(backend.StatusBadGateway, "Loki returned more entries than requested")
			}
			var timestamp, line string
			if len(value) < 2 || len(value) > 3 || json.Unmarshal(value[0], &timestamp) != nil ||
				json.Unmarshal(value[1], &line) != nil || len(line) > maxLineBytes {
				return nil, nil, lokiFailure(backend.StatusBadGateway, "Loki returned an invalid log entry")
			}
			ns, err := strconv.ParseInt(timestamp, 10, 64)
			if err != nil || ns < window.From.UnixNano() || ns > window.To.UnixNano() {
				return nil, nil, lokiFailure(backend.StatusBadGateway, "Loki returned a log entry with an invalid query timestamp")
			}
			lines = append(lines, line)
		}
	}
	if !latest && len(lines) == limit {
		gaps = append(gaps, "Loki entry limit reached. Narrow the time range")
	}
	if len(payload.Warnings) != 0 {
		gaps = append(gaps, "Loki returned query warnings")
	}
	return lines, gaps, nil
}

func lokiFailure(status backend.Status, message string) *backend.DataResponse {
	response := backend.ErrDataResponseWithSource(status, backend.ErrorSourceDownstream, message)
	return &response
}

func lokiTransportFailure(err error) *backend.DataResponse {
	var networkError net.Error
	switch {
	case errors.Is(err, context.Canceled):
		return lokiFailure(backend.StatusTimeout, "Loki query was canceled")
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &networkError) && networkError.Timeout():
		return lokiFailure(backend.StatusTimeout, "Loki query timed out")
	default:
		return lokiFailure(backend.StatusBadGateway, "Loki request failed. Check the configured endpoint")
	}
}

func (ds *datasource) readHistoryRun(ctx context.Context, window backend.TimeRange, id string) (runRecord, *backend.DataResponse) {
	selector := `{plow_source="t3_history"} | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_activity_run" | plow_run_id=` + strconv.Quote(id)
	lines, gaps, failure := ds.loki.read(ctx, window, selector, "t3_history", runLimit)
	if failure != nil {
		return runRecord{}, failure
	}
	if len(gaps) != 0 {
		return runRecord{}, lokiFailure(backend.StatusBadGateway, "Incomplete T3 history lookup")
	}
	raw, failure := runPolicy(ctx, ds.policy, map[string]any{
		"range": "24h", "view": "lookup", "to": time.Now().UnixMilli(),
		"records": map[string][]string{"t3_history": lines},
	})
	if failure != nil {
		return runRecord{}, failure
	}
	var rows []struct {
		Thread  string
		Run     string
		Session string
		Start   *int64
		End     *int64
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return runRecord{}, policyFailure(backend.StatusInternal, "Invalid T3 history result")
	}
	if len(rows) != 1 || rows[0].Run != id || !identifier.MatchString(rows[0].Session) ||
		rows[0].Start == nil || rows[0].End == nil || *rows[0].Start == 0 || *rows[0].End == 0 {
		return runRecord{}, lokiFailure(backend.StatusNotFound, "No unambiguous, strongly bound run in this time range")
	}
	row := rows[0]
	return runRecord{ID: row.Run, ThreadID: row.Thread, SessionID: row.Session, StartedMS: row.Start, CompletedMS: row.End}, nil
}
