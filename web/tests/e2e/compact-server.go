// Local E2E fixture: real SQLite, log reader, HTTP API and embedded production UI.
package main

import (
	"context"
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
	}
	for i, c := range cases {
		body := "=== REQUEST INFO ===\nURL: " + c.endpoint + "\n=== REQUEST BODY ===\n" + c.request + "\n"
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
