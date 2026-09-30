package cpa

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// SessionLabelFromLog reads only client-facing content. Ordinary answers and
// upstream retry responses must never become a session's name.
func SessionLabelFromLog(entry *LogEntry) (title, source string) {
	if entry == nil || entry.RequestTruncated {
		return "", ""
	}
	var request map[string]any
	if json.Unmarshal([]byte(entry.RequestBody), &request) != nil {
		return "", ""
	}
	system, users := requestLabelText(request)
	naming := namingInstruction(system)
	// Claude Code also puts the naming instruction in a user message when the
	// output schema explicitly permits only a title. A title schema alone is not evidence.
	if !naming && titleOnlySchema(request) {
		naming = shortTitleInstruction.MatchString(system + "\n" + strings.Join(users, "\n"))
	}
	if naming {
		if entry.ResponseTruncated {
			return "", ""
		}
		body, ok := finalLabelResponse(entry.ResponseBody)
		if !ok {
			return "", ""
		}
		text := responseLabelText(body)
		if title := cleanGeneratedTitle(text); title != "" {
			return title, "generated_title"
		}
		return "", "" // Never preview the helper's instruction/transcript as the task.
	}
	for _, text := range users {
		text = cleanPromptPreview(text)
		if text != "" {
			return text, "prompt_preview"
		}
	}
	return "", ""
}

func requestLabelText(request map[string]any) (string, []string) {
	systems := []string{textParts(request["system"]), textParts(request["instructions"]), textParts(request["systemInstruction"]), textParts(request["system_instruction"])}
	users := []string{}
	if input, ok := request["input"].(string); ok {
		users = append(users, input)
	}
	for _, key := range []string{"messages", "input", "contents"} {
		items, _ := request[key].([]any)
		for _, item := range items {
			m, _ := item.(map[string]any)
			if m == nil {
				continue
			}
			role, _ := m["role"].(string)
			if role == "" && key == "input" && (m["type"] == nil || m["type"] == "message") {
				role = "user"
			}
			content := m["content"]
			if content == nil {
				content = m["parts"]
			}
			text := textParts(content)
			switch role {
			case "system", "developer":
				systems = append(systems, text)
			case "user":
				// Codex can put AGENTS/environment scaffolding and the real
				// prompt in separate text parts of the same user message.
				if parts, ok := content.([]any); ok {
					for _, part := range parts {
						users = append(users, textParts(part))
					}
				} else {
					users = append(users, text)
				}
			}
		}
	}
	return strings.Join(systems, "\n"), users
}

// Ignore images, tool results, reasoning and encrypted content when naming.
func textParts(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		texts := []string{}
		for _, p := range v {
			if t := textParts(p); t != "" {
				texts = append(texts, t)
			}
		}
		return strings.Join(texts, "\n")
	case map[string]any:
		kind, _ := v["type"].(string)
		if kind != "" && kind != "text" && kind != "input_text" && kind != "output_text" {
			return ""
		}
		if text, ok := v["text"].(string); ok {
			return text
		}
		if v["parts"] != nil {
			return textParts(v["parts"])
		}
	}
	return ""
}

var shortTitleInstruction = regexp.MustCompile(`(?i)\b(?:generate|return|write|create) (?:a |the )?(?:short|concise) (?:[a-z]+ )?title\b`)

func namingInstruction(text string) bool {
	t := strings.ToLower(text)
	if strings.Contains(t, "naming a coding session") {
		return true
	}
	for _, sentence := range strings.FieldsFunc(t, func(r rune) bool { return r == '.' || r == '\n' }) {
		subject := strings.Contains(sentence, "session") || strings.Contains(sentence, "conversation") || strings.Contains(sentence, "thread") || strings.Contains(sentence, "task")
		if subject && shortTitleInstruction.MatchString(sentence) {
			return true
		}
	}
	return false
}
func nestedMap(v any, keys ...string) map[string]any {
	for _, key := range keys {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[key]
	}
	m, _ := v.(map[string]any)
	return m
}
func titleOnlySchema(request map[string]any) bool {
	for _, path := range [][]string{{"output_config", "format", "schema", "properties"}, {"text", "format", "schema", "properties"}, {"response_format", "json_schema", "schema", "properties"}} {
		p := nestedMap(request, path...)
		if len(p) == 1 && p["title"] != nil {
			return true
		}
	}
	return false
}

var statusLine = regexp.MustCompile(`^Status:\s*(\d{3})\s*$`)

func finalLabelResponse(raw string) (string, bool) {
	raw = strings.TrimSpace(strings.ReplaceAll(raw, "\r\n", "\n"))
	first, _, _ := strings.Cut(raw, "\n")
	if match := statusLine.FindStringSubmatch(first); match != nil {
		if match[1][0] != '2' {
			return "", false
		}
		_, body, ok := strings.Cut(raw, "\n\n")
		return strings.TrimSpace(body), ok
	}
	return raw, raw != ""
}
func responseLabelText(body string) string {
	var obj map[string]any
	if json.Unmarshal([]byte(body), &obj) == nil {
		return responseObjectText(obj)
	}
	// SSE: a completed response supersedes deltas to prevent duplicated titles.
	var deltas strings.Builder
	final := ""
	detected := false
	completed := false
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		detected = true
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			completed = true
			continue
		}
		var o map[string]any
		if json.Unmarshal([]byte(data), &o) != nil {
			continue
		}
		if o["type"] == "message_stop" {
			completed = true
		}
		if o["error"] != nil || o["type"] == "error" || o["type"] == "response.failed" || o["type"] == "response.incomplete" {
			return ""
		}
		if r, ok := o["response"].(map[string]any); ok && o["type"] == "response.completed" {
			final = responseObjectText(r)
			continue
		}
		if o["type"] == "response.output_text.delta" {
			if t, ok := o["delta"].(string); ok {
				deltas.WriteString(t)
			}
			continue
		}
		if o["type"] == "content_block_delta" {
			d, _ := o["delta"].(map[string]any)
			if d["type"] == "text_delta" {
				deltas.WriteString(textParts(d["text"]))
			}
			continue
		}
		if o["type"] == "content_block_start" {
			b, _ := o["content_block"].(map[string]any)
			deltas.WriteString(textParts(b))
			continue
		}
		deltas.WriteString(responseObjectText(o))
	}
	if final != "" {
		return final
	}
	if detected {
		if !completed {
			return ""
		}
		return deltas.String()
	}
	// Some clients log a plain-text final response.
	return body
}
func responseObjectText(o map[string]any) string {
	if o["error"] != nil || o["status"] == "failed" || o["status"] == "incomplete" {
		return ""
	}
	if title, ok := o["title"].(string); ok {
		return title
	}
	if text, ok := o["output_text"].(string); ok {
		return text
	}
	if r, ok := o["response"].(map[string]any); ok {
		return responseObjectText(r)
	}
	if c := textParts(o["content"]); c != "" {
		return c
	}
	var result strings.Builder
	if output, ok := o["output"].([]any); ok {
		for _, v := range output {
			m, _ := v.(map[string]any)
			if m["type"] == "message" {
				result.WriteString(textParts(m["content"]))
			}
		}
	}
	if choices, ok := o["choices"].([]any); ok && len(choices) > 0 {
		m, _ := choices[0].(map[string]any)
		for _, key := range []string{"message", "delta"} {
			d, _ := m[key].(map[string]any)
			result.WriteString(textParts(d["content"]))
		}
	}
	if candidates, ok := o["candidates"].([]any); ok && len(candidates) > 0 {
		m, _ := candidates[0].(map[string]any)
		c, _ := m["content"].(map[string]any)
		result.WriteString(textParts(c["parts"]))
	}
	return result.String()
}
func cleanGeneratedTitle(text string) string {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```") {
		if !strings.HasSuffix(text, "```") {
			return ""
		}
		lines := strings.Split(text, "\n")
		if len(lines) < 3 {
			return ""
		}
		text = strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
	}
	var obj map[string]any
	if json.Unmarshal([]byte(text), &obj) == nil {
		value, ok := obj["title"].(string)
		if !ok {
			return ""
		}
		text = strings.TrimSpace(value)
	}
	text = strings.Trim(text, "\"“”")
	if text == "" || utf8.RuneCountInString(text) > 160 || strings.ContainsAny(text, "\n\r{}<>") || strings.IndexFunc(text, unicode.IsControl) >= 0 {
		return ""
	}
	return text
}

var contextBlocks = regexp.MustCompile(`(?s)<(environment_context|system-reminder|permissions instructions|collaboration_mode)>.*?</(?:environment_context|system-reminder|permissions instructions|collaboration_mode)>`)

func cleanPromptPreview(text string) string {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "# AGENTS.md instructions") || strings.HasPrefix(text, "<INSTRUCTIONS>") {
		return ""
	}
	text = strings.TrimSpace(contextBlocks.ReplaceAllString(text, ""))
	if text == "" || strings.HasPrefix(text, "<") {
		return ""
	}
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) > 100 {
		text = string(runes[:100]) + "…"
	}
	return text
}
