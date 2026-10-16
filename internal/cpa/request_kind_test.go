package cpa

import "testing"

// Failure matrix: endpoint lookalikes and prompt text, old checkpoint replay,
// configured-but-unused compaction, truncated/missing JSON, partial SSE,
// failed compact calls, upstream-only evidence, and mixed WS connections.
func TestRequestKindFromLog(t *testing.T) {
	trigger := `{"input":[{"type":"compaction_trigger"}]}`
	normal := `{"input":[{"role":"user","content":"Please discuss compaction_trigger"}]}`
	checkpoint := `{"type":"compaction","encrypted_content":"opaque"}`
	done := `{"type":"response.completed","response":{"output":[` + checkpoint + `]}}`
	cases := []struct {
		name     string
		entry    LogEntry
		kind     string
		complete bool
	}{
		{"legacy failed", LogEntry{Info: map[string]string{"URL": "/v1/responses/compact?x=1"}}, "compact", true},
		{"lookalike", LogEntry{Info: map[string]string{"URL": "/v1/responses?next=/responses/compact"}, RequestBody: normal, ResponseBody: `{"output":[]}`}, "normal", true},
		{"trigger failed", LogEntry{RequestBody: trigger, ResponseBody: `{"error":{"message":"failed"}}`}, "compact", true},
		{"new SSE output", LogEntry{RequestBody: normal, ResponseBody: "data: " + done + "\n\ndata: [DONE]"}, "compact", true},
		{"replay", LogEntry{RequestBody: `{"input":[` + checkpoint + `],"context_management":[{"type":"compaction"}]}`, ResponseBody: `{"output":[` + checkpoint + `]}`}, "normal", true},
		{"normal", LogEntry{RequestBody: normal, ResponseBody: `{"output_text":"done"}`}, "normal", true},
		{"missing", LogEntry{}, "unknown", false},
		{"broken", LogEntry{RequestBody: `{"input":[`, ResponseBody: `{"output":[]}`}, "unknown", false},
		{"truncated", LogEntry{RequestBody: normal, ResponseBody: `{"output":[]}`, ResponseTruncated: true}, "unknown", false},
		{"stream unfinished", LogEntry{RequestBody: normal, ResponseBody: `data: {"type":"response.output_text.delta","delta":"hi"}`}, "unknown", false},
		{"upstream only", LogEntry{RequestBody: normal, APIResponses: []APIResponse{{Body: done}}}, "compact", true},
		{"shared websocket", LogEntry{WebsocketTimeline: "Timestamp: now\nEvent: websocket.request\n" + normal + "\nTimestamp: now\nEvent: websocket.response\n{\"type\":\"response.completed\",\"response\":{\"output\":[]}}\nTimestamp: now\nEvent: websocket.request\n" + trigger}, "contains_compact", true},
		{"websocket replay", LogEntry{WebsocketTimeline: "Timestamp: now\nEvent: websocket.request\n{\"input\": [" + checkpoint + "]}\nTimestamp: now\nEvent: websocket.response\n{\"type\":\"response.completed\",\"response\":{\"output\":[]}}"}, "unknown", false},
		{"API websocket", LogEntry{APIWebsocketTimeline: "Timestamp: now\nEvent: api.websocket.request\nHeaders:\nX-Test: yes\n\nBody:\n" + trigger + "\nTimestamp: now\nEvent: api.websocket.response\n" + done}, "contains_compact", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, complete := RequestKindFromLog(&tc.entry)
			if kind != tc.kind || complete != tc.complete {
				t.Fatalf("got %q %v; want %q %v", kind, complete, tc.kind, tc.complete)
			}
		})
	}
}
