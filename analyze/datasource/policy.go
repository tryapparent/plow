package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

type runRecord struct {
	ID          string `json:"id"`
	ThreadID    string `json:"threadId"`
	SessionID   string `json:"sessionId"`
	StartedMS   *int64 `json:"startedMs"`
	CompletedMS *int64 `json:"completedMs"`
}

type eventRecord struct {
	EventID     string `json:"eventId"`
	SessionID   string `json:"sessionId"`
	CallID      string `json:"callId"`
	Kind        string `json:"kind"`
	TimestampMS *int64 `json:"timestampMs"`
}

type policyInput struct {
	Run    runRecord     `json:"run"`
	Events []eventRecord `json:"events"`
}

type policyOutput struct {
	RunID     string `json:"runId"`
	Intervals []struct {
		CallID     string `json:"callId"`
		Kind       string `json:"kind"`
		StartMS    *int64 `json:"startMs"`
		EndMS      *int64 `json:"endMs"`
		DurationMS *int64 `json:"durationMs"`
	} `json:"intervals"`
	Findings []struct {
		CallID string `json:"callId"`
		Reason string `json:"reason"`
	} `json:"findings"`
	Coverage struct {
		Events  *int64 `json:"events"`
		Paired  *int64 `json:"paired"`
		Unknown *int64 `json:"unknown"`
	} `json:"coverage"`
}

func runPolicy(ctx context.Context, path string, input any) ([]byte, *backend.DataResponse) {
	body, err := json.Marshal(input)
	if err != nil {
		return nil, policyFailure(backend.StatusInternal, "Could not encode the policy input")
	}

	ctx, cancel := context.WithTimeout(ctx, ioTimeout)
	defer cancel()
	stdout := &boundedOutput{}
	command := exec.CommandContext(ctx, path)
	command.WaitDelay = 250 * time.Millisecond
	command.Stdin = bytes.NewReader(body)
	command.Stdout = stdout
	if err := command.Run(); err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return nil, policyFailure(backend.StatusTimeout, "Policy executable timed out")
		case errors.Is(ctx.Err(), context.Canceled):
			return nil, policyFailure(backend.StatusTimeout, "Policy execution was canceled")
		case stdout.exceeded:
			return nil, policyFailure(backend.StatusInternal, "Policy output exceeded 4 MiB")
		default:
			return nil, policyFailure(backend.StatusInternal, "Policy executable failed")
		}
	}

	return stdout.buffer.Bytes(), nil
}

func executePolicy(ctx context.Context, path string, input policyInput) (policyOutput, *backend.DataResponse) {
	var output policyOutput
	raw, failure := runPolicy(ctx, path, input)
	if failure != nil {
		return output, failure
	}

	if json.Unmarshal(raw, &output) != nil || output.RunID != input.Run.ID ||
		output.Intervals == nil || output.Findings == nil || output.Coverage.Events == nil ||
		output.Coverage.Paired == nil || output.Coverage.Unknown == nil {
		return output, policyFailure(backend.StatusInternal, "Policy executable returned an invalid result")
	}
	for _, interval := range output.Intervals {
		if interval.Kind == "" {
			return output, policyFailure(backend.StatusInternal, "Policy executable returned an invalid interval")
		}
	}
	for _, finding := range output.Findings {
		if finding.Reason == "" {
			return output, policyFailure(backend.StatusInternal, "Policy executable returned an invalid finding")
		}
	}
	return output, nil
}

type boundedOutput struct {
	buffer   bytes.Buffer
	exceeded bool
}

func (o *boundedOutput) Write(p []byte) (int, error) {
	if o.buffer.Len()+len(p) > maxResponseBytes {
		o.exceeded = true
		return 0, errors.New("policy output exceeds byte limit")
	}
	return o.buffer.Write(p)
}

func policyFailure(status backend.Status, message string) *backend.DataResponse {
	response := backend.ErrDataResponseWithSource(status, backend.ErrorSourcePlugin, message)
	return &response
}

func render(output policyOutput, gaps []string) backend.DataResponse {
	intervals := data.NewFrame("intervals",
		data.NewField("callId", nil, []string{}),
		data.NewField("kind", nil, []string{}),
		data.NewField("startMs", nil, []*int64{}),
		data.NewField("endMs", nil, []*int64{}),
		data.NewField("durationMs", nil, []*int64{}),
	)
	for _, interval := range output.Intervals {
		intervals.AppendRow(interval.CallID, interval.Kind, interval.StartMS, interval.EndMS, interval.DurationMS)
	}

	findings := data.NewFrame("findings",
		data.NewField("callId", nil, []string{}),
		data.NewField("reason", nil, []string{}),
	)
	for _, finding := range output.Findings {
		findings.AppendRow(finding.CallID, finding.Reason)
	}

	sourceGaps := strings.Join(gaps, ". ")
	coverage := data.NewFrame("coverage",
		data.NewField("runId", nil, []string{output.RunID}),
		data.NewField("events", nil, []int64{*output.Coverage.Events}),
		data.NewField("paired", nil, []int64{*output.Coverage.Paired}),
		data.NewField("unknown", nil, []int64{*output.Coverage.Unknown}),
		data.NewField("sourceComplete", nil, []bool{len(gaps) == 0}),
		data.NewField("sourceGaps", nil, []string{sourceGaps}),
	)
	for _, frame := range []*data.Frame{intervals, findings, coverage} {
		if len(gaps) != 0 {
			frame.Meta = &data.FrameMeta{
				Notices: []data.Notice{{Severity: data.NoticeSeverityWarning, Text: sourceGaps}},
			}
		}
	}
	return backend.DataResponse{Frames: data.Frames{intervals, findings, coverage}}
}

type activityLane struct {
	ID    string
	Spans []struct {
		First     int64
		Last      int64
		Category  string
		Operation string
		Run       string
	}
}

type activityTotal struct {
	Category  string
	Operation string
	MS        int64
}

type activityOutput struct {
	From            int64
	Cutoff          int64
	Oldest          int64
	T3Coverage      string
	CodexCoverage   string
	CICoverage      string
	OutcomeCoverage string
	UnknownRuns     int64
	Conflicts       int64
	Threads         []activityLane
	Links           []struct {
		Thread string
		Run    string
		Source string
		First  int64
		Last   int64
	}
	CI         []activityLane
	Totals     []activityTotal
	Categories []activityTotal
	Buckets    []struct {
		Time    int64
		Threads int64
		Share   *float64
	}
	Findings []struct {
		Kind        string
		Occurrences int64
		Measured    int64
		MS          *int64
		Next        string
	}
}

func timeField(ms int64) *time.Time {
	if ms == 0 {
		return nil
	}
	at := time.UnixMilli(ms).UTC()
	return &at
}

func renderActivity(report activityOutput, view string) data.Frames {
	switch view {
	case "coverage":
		return data.Frames{data.NewFrame("Source coverage",
			data.NewField("Source", nil, []string{"T3", "Codex", "GitHub CI", "Outcome delay"}),
			data.NewField("Coverage", nil, []string{report.T3Coverage, report.CodexCoverage, report.CICoverage, report.OutcomeCoverage}),
			data.NewField("Cutoff (UTC)", nil, []*time.Time{timeField(report.Cutoff), nil, nil, nil}),
			data.NewField("Oldest source clock", nil, []*time.Time{timeField(report.Oldest), nil, nil, nil}),
			data.NewField("Clock gaps", nil, []*int64{&report.UnknownRuns, nil, nil, nil}),
			data.NewField("Conflicts", nil, []*int64{&report.Conflicts, nil, nil, nil}),
		)}
	case "breakdown":
		categories := data.NewFrame("Categories",
			data.NewField("Category", nil, []string{}),
			data.NewField("Elapsed", nil, []int64{}))
		operations := data.NewFrame("Operations",
			data.NewField("Category", nil, []string{}),
			data.NewField("Operation", nil, []string{}),
			data.NewField("Elapsed", nil, []int64{}))
		for _, total := range report.Categories {
			categories.AppendRow(total.Category, total.MS)
		}
		for _, total := range report.Totals {
			operations.AppendRow(total.Category, total.Operation, total.MS)
		}
		return data.Frames{categories, operations}
	case "share":
		frame := data.NewFrame("Mean per-thread work share",
			data.NewField("Time", nil, []time.Time{}),
			data.NewField("Agent work share", nil, []*float64{}))
		for _, bucket := range report.Buckets {
			var share *float64
			if bucket.Share != nil {
				value := *bucket.Share / 100
				share = &value
			}
			frame.AppendRow(time.UnixMilli(bucket.Time).UTC(), share)
		}
		return data.Frames{frame}
	case "timeline":
		return renderTimeline(report.Threads)
	case "ci":
		return renderTimeline(report.CI)
	case "runs":
		frame := data.NewFrame("Exact run links",
			data.NewField("Thread", nil, []string{}),
			data.NewField("Run", nil, []string{}),
			data.NewField("History", nil, []string{}),
			data.NewField("From (UTC)", nil, []time.Time{}),
			data.NewField("To (UTC)", nil, []time.Time{}))
		for _, link := range report.Links {
			history := ""
			if link.Source == "t3_history" {
				history = "1"
			}
			frame.AppendRow(link.Thread, link.Run, history, time.UnixMilli(link.First).UTC(), time.UnixMilli(link.Last).UTC())
		}
		return data.Frames{frame}
	case "findings":
		frame := data.NewFrame("Ranked findings",
			data.NewField("Finding", nil, []string{}),
			data.NewField("Occurrences", nil, []int64{}),
			data.NewField("Measured", nil, []int64{}),
			data.NewField("Measured impact", nil, []*int64{}),
			data.NewField("Next step", nil, []string{}))
		for _, finding := range report.Findings {
			frame.AppendRow(finding.Kind, finding.Occurrences, finding.Measured, finding.MS, finding.Next)
		}
		return data.Frames{frame}
	default:
		return nil
	}
}

func renderTimeline(lanes []activityLane) data.Frames {
	frames := make(data.Frames, 0, len(lanes))
	for _, lane := range lanes {
		frame := data.NewFrame(lane.ID,
			data.NewField("Start time", nil, []time.Time{}),
			data.NewField("End time", nil, []time.Time{}),
			data.NewField(lane.ID, nil, []string{}))
		frame.Fields[2].Config = &data.FieldConfig{DisplayName: lane.ID}
		for _, span := range lane.Spans {
			frame.AppendRow(time.UnixMilli(span.First).UTC(), time.UnixMilli(span.Last).UTC(), span.Operation)
		}
		frames = append(frames, frame)
	}
	return frames
}
