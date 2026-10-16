package cpa

import (
	"encoding/json"
	"testing"
)

// Failure cases: case-insensitive headers; JSON-string/object client metadata;
// failed or truncated compact bodies; malformed metadata; capability flags;
// a checkpoint prompt quoted in history; summary replay; mixed WS exchanges.
func TestTextCompactionRequestKind(t *testing.T) {
	prompt := "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work."
	encode := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	message := map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": prompt}}}
	plain := `{"input":"continue"}`
	done := `{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Handoff summary"}]}]}`
	for _, tc := range []struct {
		name  string
		entry LogEntry
		want  string
	}{
		{"header on failed request", LogEntry{Headers: map[string]string{"x-codex-turn-metadata": `{"request_kind":"compaction"}`}, RequestBody: plain}, "compact"},
		{"header on truncated body", LogEntry{Headers: map[string]string{"X-Codex-Turn-Metadata": `{"request_kind":"compaction"}`}, RequestBody: `{"input":[`, RequestTruncated: true}, "compact"},
		{"body string metadata", LogEntry{RequestBody: encode(map[string]any{"client_metadata": map[string]any{"x-codex-turn-metadata": `{"request_kind":"compaction"}`}})}, "compact"},
		{"body object metadata", LogEntry{RequestBody: encode(map[string]any{"client_metadata": map[string]any{"x-codex-turn-metadata": map[string]any{"request_kind": "compaction"}}})}, "compact"},
		{"checkpoint prompt", LogEntry{RequestBody: encode(map[string]any{"input": []any{message}}), ResponseBody: done}, "compact"},
		{"old checkpoint prompt", LogEntry{RequestBody: encode(map[string]any{"input": []any{message, map[string]any{"role": "user", "content": "continue"}}}), ResponseBody: done}, "normal"},
		{"quoted checkpoint prompt", LogEntry{RequestBody: encode(map[string]any{"input": []any{map[string]any{"role": "user", "content": "Explain this prompt: " + prompt}}}), ResponseBody: done}, "normal"},
		{"capability only", LogEntry{Headers: map[string]string{"X-Codex-Beta-Features": "remote_compaction_v2", "X-Codex-Turn-Metadata": `{"request_kind":"turn"}`}, RequestBody: plain, ResponseBody: done}, "normal"},
		{"malformed metadata", LogEntry{Headers: map[string]string{"X-Codex-Turn-Metadata": `{bad`}, RequestBody: plain, ResponseBody: done}, "normal"},
		{"summary replay", LogEntry{RequestBody: `{"input":[{"role":"user","content":"Another language model started to solve this problem and produced a summary of its thinking process."}]}`, ResponseBody: done}, "normal"},
		{"WS per-request metadata", LogEntry{WebsocketTimeline: "Timestamp: now\nEvent: websocket.request\n" + encode(map[string]any{"client_metadata": map[string]any{"x-codex-turn-metadata": `{"request_kind":"compaction"}`}})}, "contains_compact"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := RequestKindFromLog(&tc.entry)
			if got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}

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
