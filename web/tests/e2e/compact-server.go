// Local E2E fixture: real SQLite, log reader, HTTP API and embedded production UI.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/api"
	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/pricing"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/storage/sqlite"
	"github.com/k0ngk0ng/cpa-usage/internal/usage"
)

func main() {
	dir := os.Getenv("COMPACT_E2E_DIR")
	if dir == "" {
		panic("COMPACT_E2E_DIR required")
	}
	must(os.MkdirAll(filepath.Join(dir, "logs"), 0700))
	// Seed the exact pre-v0.4.8 cache schema and misclassification before opening
	// the application, so migration and automatic reclassification run together.
	old, err := sql.Open("sqlite", filepath.Join(dir, "usage.db"))
	must(err)
	_, err = old.Exec("CREATE TABLE request_log_kinds (request_id TEXT PRIMARY KEY, kind TEXT, complete NUMERIC, checked_at DATETIME)")
	must(err)
	_, err = old.Exec("INSERT INTO request_log_kinds VALUES (?, ?, ?, ?)", "text-header", "normal", true, time.Now())
	must(err)
	must(old.Close())
	store, err := sqlite.Open(sqlite.Config{Path: filepath.Join(dir, "usage.db")})
	must(err)
	defer store.Close()
	user := `{"role":"user","content":"Keep my question"}`
	answer := `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Old answer to compress"}]}`
	checkpoint := `{"type":"compaction","id":"cmp-new","encrypted_content":"opaque-test-ciphertext"}`
	output := `{"object":"response.compaction","output":[` + user + `,` + checkpoint + `]}`
	done := `{"type":"response.completed","response":{"id":"resp-new","status":"completed","output":[` + user + `,` + checkpoint + `]}}`
	input := `{"model":"codex-test","input":[` + user + `,` + answer + `,{"type":"compaction_trigger"}]}`
	largeInput := `{"role":"user","content":"` + strings.Repeat("x", 9<<20) + `"}`
	prompt, _ := json.Marshal("You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.")
	textInput := `{"input":[` + user + `,` + answer + `,{"role":"user","content":` + string(prompt) + `}]}`
	textDone := `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Handoff summary: keep the tested changes."}]}]}}`
	frame := func(kind, body string) string {
		return "Timestamp: 2026-10-16T10:00:00Z\nEvent: websocket." + kind + "\n" + body + "\n"
	}
	cases := []struct{ id, endpoint, request, response, ws string }{
		{"legacy", "/v1/responses/compact", `{"input":[` + user + `,` + answer + `]}`, output, ""},
		{"v2", "/v1/responses", input, "data: " + done + "\n\ndata: [DONE]\n", ""},
		{"ws", "/v1/responses/ws", "", "", frame("request", input) + frame("response", done) + frame("request", `{"type":"response.create","input":[`+checkpoint+`,`+user+`]}`) + frame("response", `{"type":"response.completed","response":{"output":[`+answer+`]}}`)},
		{"failed", "/v1/responses", input, `{"error":{"message":"Compaction failed"}}`, ""},
		{"replay", "/v1/responses", `{"input":[` + checkpoint + `,` + user + `]}`, `{"output":[` + answer + `]}`, ""},
		{"delta", "/v1/responses", `{"previous_response_id":"unknown","input":[{"type":"compaction_trigger"}]}`, done, ""},
		{"large-normal", "/v1/responses", `{"input":[` + largeInput + `]}`, `{"output":[]}`, ""},
		{"large-compact", "/v1/responses", `{"input":[` + largeInput + `,{"type":"compaction_trigger"}]}`, output, ""},
		{"large-output", "/v1/responses", `{"input":"hello"}`, `{"padding":"` + strings.Repeat("x", 9<<20) + `","output":[` + checkpoint + `]}`, ""},
		{"canceled", "/v1/responses", `{"input":"hello"}`, "", ""},
		{"text-header", "/v1/responses", `{"input":[` + largeInput + `,` + user + `]}`, ":" + strings.Repeat("x", 2<<20) + "\n\n" + textDone, ""},
		{"text-body", "/v1/responses", `{"input":[` + user + `],"client_metadata":{"x-codex-turn-metadata":"{\"request_kind\":\"compaction\"}"}}`, textDone, ""},
		{"text-prompt", "/v1/responses", textInput, textDone, ""},
		{"text-failed", "/v1/responses", textInput, `{"error":{"message":"Compaction failed"}}`, ""},
		{"text-replay", "/v1/responses", `{"input":[{"role":"user","content":"Another language model started to solve this problem and produced a summary of its thinking process. Handoff summary: keep the tested changes."},` + user + `]}`, `{"output":[` + answer + `]}`, ""},
	}
	for i, c := range cases {
		body := "=== REQUEST INFO ===\nURL: " + c.endpoint + "\n=== REQUEST BODY ===\n" + c.request + "\n"
		if c.id == "text-header" {
			body = "=== REQUEST INFO ===\nURL: " + c.endpoint + "\n=== HEADERS ===\nX-Codex-Turn-Metadata: {\"request_kind\":\"compaction\"}\n=== REQUEST BODY ===\n" + c.request + "\n"
		}
		if c.ws != "" {
			body += "=== WEBSOCKET TIMELINE ===\n" + c.ws
		} else {
			body += "=== API RESPONSE 1 ===\nStatus: 200\nBody:\n" + c.response + "\n=== RESPONSE ===\nStatus: 200\nContent-Type: application/json\n\n" + c.response + "\n"
		}
		must(os.WriteFile(filepath.Join(dir, "logs", "responses-2026-10-16T100000-"+c.id+".log"), []byte(body), 0600))
		_, _, err = store.InsertUsageEvents(context.Background(), []storage.UsageEvent{{EventKey: c.id, RequestID: c.id, SessionID: "compact-e2e", Model: "codex-test", Endpoint: c.endpoint, Timestamp: time.Now().UTC().Add(time.Duration(i) * time.Second), Generate: true, TotalTokens: 42}})
		must(err)
	}
	p := pricing.New(store)
	router := api.New(api.RouterConfig{BasePath: "/usage", Usage: api.UsageDeps{Store: store, Service: usage.New(store, p, usage.NewDisplayResolver(store)), LogReader: &cpa.LogReader{Dir: filepath.Join(dir, "logs")}}, Meta: api.MetaDeps{Store: store}, Pricing: api.PricingDeps{Service: p}})
	fmt.Println("compact E2E listening")
	must(http.ListenAndServe("127.0.0.1:18328", router))
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
