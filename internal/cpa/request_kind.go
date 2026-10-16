package cpa

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

// RequestKindFromLog classifies request intent, not CPA's session continuation
// flag. Shared websocket transcripts cannot identify one usage execution.
func RequestKindFromLog(entry *LogEntry) (kind string, complete bool) {
	if entry == nil {
		return "unknown", false
	}
	if IsCompactEndpoint(entry.Info["URL"]) {
		return "compact", true
	}
	if strings.TrimSpace(entry.WebsocketTimeline) != "" {
		if websocketHasCompaction(entry.WebsocketTimeline) || websocketHasCompaction(entry.APIWebsocketTimeline) {
			return "contains_compact", true
		}
		return "unknown", false // The connection transcript can still grow.
	}
	request := kindObject(entry.RequestBody)
	if hasCompactionTrigger(request) || textCompactionIntent(request, entry.Headers) {
		return "compact", true
	}
	existing := checkpointSet(request["input"])
	compact, finished := responseCompaction(entry.ResponseBody, existing)
	if compact {
		return "compact", true
	}
	// Upstream evidence can identify compact intent even if the final failed.
	for _, attempt := range entry.APIResponses {
		if compact, _ := responseCompaction(attempt.Body, existing); compact {
			return "compact", true
		}
	}
	if websocketHasCompaction(entry.APIWebsocketTimeline) {
		return "contains_compact", true
	}
	if len(request) > 0 && finished && !entry.RequestTruncated && !entry.ResponseTruncated {
		return "normal", true
	}
	return "unknown", false
}

func IsCompactEndpoint(endpoint string) bool {
	u, err := url.Parse(strings.TrimSpace(endpoint))
	return err == nil && strings.HasSuffix(strings.TrimSuffix(u.Path, "/"), "/responses/compact")
}

func kindObject(raw string) map[string]any {
	var object map[string]any
	if json.Unmarshal([]byte(raw), &object) != nil {
		return nil
	}
	return object
}

func hasCompactionTrigger(request map[string]any) bool {
	input, _ := request["input"].([]any)
	for _, item := range input {
		object, _ := item.(map[string]any)
		if object["type"] == "compaction_trigger" {
			return true
		}
	}
	return false
}

func checkpointSet(value any) map[string]bool {
	set := map[string]bool{}
	items, _ := value.([]any)
	for _, item := range items {
		object, _ := item.(map[string]any)
		if object["type"] != "compaction" && object["type"] != "compaction_summary" {
			continue
		}
		canonical := make(map[string]any, len(object))
		for key, value := range object {
			if key != "id" && key != "status" {
				canonical[key] = value
			}
		}
		encoded, _ := json.Marshal(canonical)
		set[string(encoded)] = true
	}
	return set
}

func responseCompaction(raw string, existing map[string]bool) (compact, finished bool) {
	raw = strings.TrimSpace(strings.ReplaceAll(raw, "\r\n", "\n"))
	first, _, _ := strings.Cut(raw, "\n")
	if statusLine.MatchString(first) {
		_, raw, _ = strings.Cut(raw, "\n\n")
	}
	inspect := func(object map[string]any) {
		if object == nil {
			return
		}
		typ, _ := object["type"].(string)
		switch typ {
		case "response.completed", "response.failed", "response.incomplete", "response.cancelled", "error":
			finished = true
		}
		if typ == "" {
			for _, field := range []string{"output", "output_text", "choices", "content", "candidates", "error"} {
				if _, ok := object[field]; ok {
					finished = true
				}
			}
		}
		if nested, ok := object["response"].(map[string]any); ok {
			object = nested
		}
		if object["object"] == "response.compaction" {
			compact = true
		}
		output := object["output"]
		if typ == "response.output_item.done" {
			output = []any{object["item"]}
		}
		for checkpoint := range checkpointSet(output) {
			if !existing[checkpoint] {
				compact = true
			}
		}
	}
	if object := kindObject(raw); object != nil {
		inspect(object)
		return
	}
	for _, line := range strings.Split(raw, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "data:"))
		if payload == "[DONE]" {
			finished = true
			continue
		}
		inspect(kindObject(payload))
	}
	return
}

var websocketKindFrames = regexp.MustCompile(`(?m)^Timestamp: [^\n]*\n`)

func websocketHasCompaction(raw string) bool {
	existing := map[string]bool{}
	for _, frame := range websocketKindFrames.Split(strings.ReplaceAll(raw, "\r\n", "\n"), -1) {
		line, payload, _ := strings.Cut(strings.TrimSpace(frame), "\n")
		switch line {
		case "Event: websocket.request", "Event: api.websocket.request":
			if _, body, ok := strings.Cut(payload, "\nBody:\n"); ok {
				payload = body
			}
			request := kindObject(payload)
			if hasCompactionTrigger(request) || textCompactionIntent(request, nil) {
				return true
			}
			existing = checkpointSet(request["input"])
		case "Event: websocket.response", "Event: api.websocket.response":
			if compact, _ := responseCompaction(payload, existing); compact {
				return true
			}
		}
	}
	return false
}
