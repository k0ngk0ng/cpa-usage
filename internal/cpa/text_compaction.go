package cpa

import "strings"

// Codex also performs compaction as a normal Responses call returning a text
// handoff. Its request metadata identifies the intent independently of output.
func textCompactionIntent(request map[string]any, headers map[string]string) bool {
	for key, value := range headers {
		if strings.EqualFold(key, "x-codex-turn-metadata") && compactionMetadata(value) {
			return true
		}
	}
	metadata, _ := request["client_metadata"].(map[string]any)
	for key, value := range metadata {
		if strings.EqualFold(key, "x-codex-turn-metadata") && compactionMetadata(value) {
			return true
		}
	}
	// A historical/quoted instruction or an already supplied handoff summary
	// does not establish a new compaction. Only match the exact active prompt.
	if input, ok := request["input"].(string); ok {
		return isCheckpointPrompt(input)
	}
	input, _ := request["input"].([]any)
	if len(input) == 0 {
		return false
	}
	last, _ := input[len(input)-1].(map[string]any)
	if last["role"] != "user" || (last["type"] != nil && last["type"] != "message") {
		return false
	}
	if content, ok := last["content"].(string); ok {
		return isCheckpointPrompt(content)
	}
	content, _ := last["content"].([]any)
	var parts []string
	for _, part := range content {
		object, _ := part.(map[string]any)
		if object["type"] != "input_text" && object["type"] != "text" {
			return false
		}
		text, _ := object["text"].(string)
		parts = append(parts, text)
	}
	return isCheckpointPrompt(strings.Join(parts, "\n"))
}

func compactionMetadata(value any) bool {
	if raw, ok := value.(string); ok {
		value = kindObject(raw)
	}
	object, _ := value.(map[string]any)
	return object["request_kind"] == "compaction"
}

func isCheckpointPrompt(text string) bool {
	return strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n")) == checkpointPrompt
}

const checkpointPrompt = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`
