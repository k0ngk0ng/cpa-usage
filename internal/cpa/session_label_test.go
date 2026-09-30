package cpa

import (
	"encoding/json"
	"strings"
	"testing"
)

func labelEntry(request any, response string) *LogEntry {
	b, _ := json.Marshal(request)
	return &LogEntry{RequestBody: string(b), ResponseBody: response}
}
func TestSessionLabelProtocolsAndEvidence(t *testing.T) {
	cases := []struct {
		name                    string
		request                 any
		response, title, source string
	}{
		{"Codex string input preview", map[string]any{"instructions": "You are a coding assistant.", "input": "修复登录页面的超时问题"}, `{"output_text":"Sure"}`, "修复登录页面的超时问题", "prompt_preview"},
		{"Codex scaffold and tools ignored", map[string]any{"input": []any{map[string]any{"role": "user", "content": "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>Do things</INSTRUCTIONS>"}, map[string]any{"role": "user", "content": "<environment_context>cwd=/repo</environment_context>"}, map[string]any{"type": "function_call_output", "output": "secret tool output"}, map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "Fix token accounting"}}}}}, `{"output":[]}`, "Fix token accounting", "prompt_preview"},
		{"Claude preview", map[string]any{"system": "Be helpful", "messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "content": "ignore tool result"}, map[string]any{"type": "text", "text": "Add tracing support"}}}}}, "", "Add tracing support", "prompt_preview"},
		{"Claude naming with schema", map[string]any{"system": "You are Claude Code. Return a short title.", "output_config": map[string]any{"format": map[string]any{"schema": map[string]any{"properties": map[string]any{"title": map[string]any{"type": "string"}}}}}, "messages": []any{map[string]any{"role": "user", "content": "Fix startup"}}}, "Status: 200\nContent-Type: application/json\n\n" + `{"content":[{"type":"text","text":"{\"title\":\"修复启动失败\"}"}]}`, "修复启动失败", "generated_title"},
		{"Codex naming Responses output", map[string]any{"instructions": "Generate a concise title that summarizes this session.", "input": "Fix startup"}, `{"output":[{"type":"message","content":[{"type":"output_text","text":"Fix startup failure"}]}]}`, "Fix startup failure", "generated_title"},
		{"Claude schema instruction in user", map[string]any{"output_config": map[string]any{"format": map[string]any{"schema": map[string]any{"properties": map[string]any{"title": map[string]any{"type": "string"}}}}}, "messages": []any{map[string]any{"role": "user", "content": "Return a short title summarizing this conversation"}}}, `{"content":[{"type":"text","text":"Database migration"}]}`, "Database migration", "generated_title"},
		{"ordinary title question", map[string]any{"messages": []any{map[string]any{"role": "user", "content": "Generate a concise title for this session"}}}, `{"content":[{"type":"text","text":"Not an automatic title"}]}`, "Generate a concise title for this session", "prompt_preview"},
		{"book schema is not naming", map[string]any{"output_config": map[string]any{"format": map[string]any{"schema": map[string]any{"properties": map[string]any{"title": map[string]any{"type": "string"}}}}}, "messages": []any{map[string]any{"role": "user", "content": "What is the title of the book?"}}}, `{"title":"Book name"}`, "What is the title of the book?", "prompt_preview"},
		{"unrelated system words", map[string]any{"instructions": "Generate code for the task. Keep explanations short. HTML uses a title tag.", "input": "Fix login"}, `{"output_text":"Wrong title"}`, "Fix login", "prompt_preview"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			title, source := SessionLabelFromLog(labelEntry(tc.request, tc.response))
			if title != tc.title || source != tc.source {
				t.Fatalf("got %q/%s, want %q/%s", title, source, tc.title, tc.source)
			}
		})
	}
}
func TestSessionLabelStreamsAndFailures(t *testing.T) {
	request := map[string]any{"system": "Generate a concise title for this session.", "messages": []any{map[string]any{"role": "user", "content": "The conversation"}}}
	for _, body := range []string{
		"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Fix \"}}\n\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"login\"}}\n\ndata: {\"type\":\"message_stop\"}\n",
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Fix login\"}]}]}}\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"Fix login\"}}]}\n\ndata: [DONE]\n",
	} {
		title, source := SessionLabelFromLog(labelEntry(request, body))
		if title != "Fix login" || source != "generated_title" {
			t.Fatalf("stream: %q %s", title, source)
		}
	}
	for _, body := range []string{
		"Status: 500\n\nFix login", `{"error":{"message":"Fix login"}}`,
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"unfinished\"}\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: {\"error\":{\"message\":\"failed\"}}\n\ndata: [DONE]\n",
		strings.Repeat("x", 161), "Too many\nlines", "",
	} {
		title, source := SessionLabelFromLog(labelEntry(request, body))
		if title != "" || source != "" {
			t.Fatalf("accepted failure %q: %q/%s", body, title, source)
		}
	}
	entry := labelEntry(request, `{"content":[{"type":"text","text":"Incomplete title"}]}`)
	entry.ResponseTruncated = true
	if title, _ := SessionLabelFromLog(entry); title != "" {
		t.Fatal("accepted truncated response")
	}
	entry.ResponseTruncated = false
	entry.RequestTruncated = true
	if title, _ := SessionLabelFromLog(entry); title != "" {
		t.Fatal("accepted truncated request")
	}
}
func TestPromptPreviewUnicodeAndHiddenContext(t *testing.T) {
	text := strings.Repeat("中", 120)
	title, source := SessionLabelFromLog(labelEntry(map[string]any{"input": text}, ""))
	if len([]rune(title)) != 101 || !strings.HasSuffix(title, "…") || source != "prompt_preview" {
		t.Fatalf("preview length: %q/%s", title, source)
	}
	if got := cleanPromptPreview("<system-reminder>internal</system-reminder>\n实际问题"); got != "实际问题" {
		t.Fatal(got)
	}
}

func TestCodexPreviewSkipsScaffoldingWithinOneMessage(t *testing.T) {
	request := map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "# AGENTS.md instructions for /repo"}, map[string]any{"type": "input_text", "text": "<environment_context>cwd=/repo</environment_context>"}, map[string]any{"type": "input_text", "text": "修复会话列表"}}}}}
	title, source := SessionLabelFromLog(labelEntry(request, ""))
	if title != "修复会话列表" || source != "prompt_preview" {
		t.Fatalf("got %q/%s", title, source)
	}
}
