package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/pricing"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/storage/sqlite"
	"github.com/k0ngk0ng/cpa-usage/internal/usage"
)

// Failure matrix: list blocks on log downloads, duplicate IDs cause repeated
// downloads, missing logs hot-loop, unknown IDs cause arbitrary remote reads,
// unbounded batch/body sizes, missing auth and cached flags lost on refresh.
func TestRequestKindDiscoveryIsBoundedCachedAndSeparateFromEvents(t *testing.T) {
	s, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "kinds.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_, _, err = s.InsertUsageEvents(context.Background(), []storage.UsageEvent{{EventKey: "a", RequestID: "v2", Timestamp: time.Now()}, {EventKey: "b", RequestID: "missing", Timestamp: time.Now()}})
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	deps := UsageDeps{Store: s, Service: usage.New(s, pricing.New(s), usage.NewDisplayResolver(s)), LogDownloader: requestLogDownloaderFunc(func(_ context.Context, id string, w io.Writer) (cpa.RequestLogMeta, error) {
		calls++
		if id == "missing" {
			return cpa.RequestLogMeta{}, cpa.ErrLogNotFound
		}
		body := "=== REQUEST BODY ===\n{\"input\":[{\"type\":\"compaction_trigger\"}]}\n"
		_, err := io.WriteString(w, body)
		return cpa.RequestLogMeta{Size: int64(len(body))}, err
	})}
	r := gin.New()
	r.POST("/kinds", usageRequestKindsHandler(deps))
	r.GET("/events", usageEventsHandler(deps))
	query := func(method, path, body string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(rr, req)
		return rr
	}
	if rr := query("GET", "/events?range=all", ""); rr.Code != 200 || calls != 0 {
		t.Fatal("events list performed discovery")
	}
	for i := 0; i < 2; i++ {
		rr := query("POST", "/kinds", `{"request_ids":["v2","v2","missing","absent"]}`)
		var out struct {
			Items map[string]storage.RequestKind `json:"items"`
		}
		if err = json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if rr.Code != 200 || out.Items["v2"].Kind != "compact" || out.Items["missing"].Kind != "unknown" || len(out.Items) != 2 {
			t.Fatalf("lookup: %d %s", rr.Code, rr.Body.String())
		}
	}
	if calls != 2 {
		t.Fatalf("missing cache/cooldown: %d downloads", calls)
	}
	rr := query("GET", "/events?range=all", "")
	if !strings.Contains(rr.Body.String(), `"request_kind":"compact"`) || calls != 2 {
		t.Fatalf("cache not in list: %s", rr.Body.String())
	}
	for _, body := range []string{`{}`, `{"request_ids":["../bad"]}`, `{"request_ids":["a","b","c","d","e","f","g","h","i"]}`} {
		if rr = query("POST", "/kinds", body); rr.Code != 400 {
			t.Fatalf("invalid batch accepted: %s (%d)", body, rr.Code)
		}
	}
	protected := New(RouterConfig{BasePath: "/usage", Auth: AuthDeps{Enabled: true}, Usage: deps})
	rr = httptest.NewRecorder()
	protected.ServeHTTP(rr, httptest.NewRequest("POST", "/usage/api/v1/usage/events/request-kinds", strings.NewReader(`{"request_ids":["v2"]}`)))
	if rr.Code != 401 {
		t.Fatalf("unguarded discovery: %d", rr.Code)
	}
}

// The real compact log exceeds the display body limit. Its completed summary
// must remain available even when the terminal SSE event is beyond that limit.
func TestTextCompactionDetailReadsCompleteResponse(t *testing.T) {
	dir := t.TempDir()
	log := "=== HEADERS ===\nX-Codex-Turn-Metadata: {\"request_kind\":\"compaction\"}\n=== REQUEST BODY ===\n{\"input\":\"" + strings.Repeat("history", 100) + "\"}\n=== RESPONSE ===\nStatus: 200\n\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"" + strings.Repeat("summary", 100) + "\"}]}]}}\n"
	if err := os.WriteFile(filepath.Join(dir, "responses-text.log"), []byte(log), 0600); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/logs/:request_id", usageEventLogHandler(UsageDeps{LogReader: &cpa.LogReader{Dir: dir, MaxBodyBytes: 128}}))
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest("GET", "/logs/text", nil))
	var out struct {
		Entry cpa.LogEntry `json:"entry"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || out.Entry.RequestTruncated || out.Entry.ResponseTruncated || !strings.Contains(out.Entry.ResponseBody, "response.completed") {
		t.Fatalf("compact details truncated: status=%d request=%v response=%v", rr.Code, out.Entry.RequestTruncated, out.Entry.ResponseTruncated)
	}
}

// A checkpoint prompt or body metadata can occur after the display limit, so
// details must classify the full input even before a list lookup has run.
func TestCompactionDetailReadsIntentBeyondDisplayLimit(t *testing.T) {
	dir := t.TempDir()
	log := "=== REQUEST BODY ===\n{\"input\":\"" + strings.Repeat("history", 100) + "\",\"client_metadata\":{\"x-codex-turn-metadata\":{\"request_kind\":\"compaction\"}}}\n=== RESPONSE ===\nStatus: 200\n\n{\"output\":[{\"role\":\"assistant\",\"content\":\"handoff summary\"}]}\n"
	if err := os.WriteFile(filepath.Join(dir, "responses-text.log"), []byte(log), 0600); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/logs/:request_id", usageEventLogHandler(UsageDeps{LogReader: &cpa.LogReader{Dir: dir, MaxBodyBytes: 128}}))
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest("GET", "/logs/text", nil))
	var out struct {
		Entry cpa.LogEntry `json:"entry"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	kind, _ := cpa.RequestKindFromLog(&out.Entry)
	if rr.Code != 200 || kind != "compact" || out.Entry.RequestTruncated {
		t.Fatalf("compact intent lost: status=%d kind=%s truncated=%v", rr.Code, kind, out.Entry.RequestTruncated)
	}
}

type interruptedRequestKindStore struct {
	storage.Store
	calls   int
	failure error
}

func (s *interruptedRequestKindStore) RequestKinds(ctx context.Context, ids []string) (map[string]storage.RequestKind, error) {
	s.calls++
	// The outer lookup succeeds, then discovery reports an interrupted shared
	// operation while this HTTP caller's own context is still healthy.
	if s.calls == 2 {
		return nil, s.failure
	}
	return s.Store.RequestKinds(ctx, ids)
}

// Failure matrix: another caller cancels shared discovery, its deadline
// expires, or discovery returns an unrelated error that must remain visible.
func TestRequestKindDiscoveryRecoversForeignCancellation(t *testing.T) {
	for _, failure := range []error{context.Canceled, context.DeadlineExceeded, errors.New("storage unavailable")} {
		t.Run(failure.Error(), func(t *testing.T) {
			s, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "kinds.db")})
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if _, _, err = s.InsertUsageEvents(context.Background(), []storage.UsageEvent{{EventKey: "text", RequestID: "text", Timestamp: time.Now()}}); err != nil {
				t.Fatal(err)
			}
			store := &interruptedRequestKindStore{Store: s, failure: failure}
			deps := UsageDeps{Store: store, LogDownloader: requestLogDownloaderFunc(func(_ context.Context, _ string, w io.Writer) (cpa.RequestLogMeta, error) {
				n, err := io.WriteString(w, "=== HEADERS ===\nX-Codex-Turn-Metadata: {\"request_kind\":\"compaction\"}\n")
				return cpa.RequestLogMeta{Size: int64(n)}, err
			})}
			r := gin.New()
			r.POST("/kinds", usageRequestKindsHandler(deps))
			rr := httptest.NewRecorder()
			req := httptest.NewRequest("POST", "/kinds", strings.NewReader(`{"request_ids":["text"]}`))
			req.Header.Set("Content-Type", "application/json")
			r.ServeHTTP(rr, req)
			if failure == context.Canceled || failure == context.DeadlineExceeded {
				if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"kind":"compact"`) {
					t.Fatalf("healthy caller lost classification: %d %s", rr.Code, rr.Body.String())
				}
			} else if rr.Code != 500 || store.calls != 2 {
				t.Fatalf("unrelated failure was retried or hidden: %d %s (%d calls)", rr.Code, rr.Body.String(), store.calls)
			}
		})
	}
}

// Failure matrix: local/remote logs rejected above 8 MiB, a trigger after a
// large input truncated away, compaction output after a large response lost,
// and a canceled upstream with no response incorrectly classified as normal.
func TestRequestKindDiscoveryReadsEntireLargeLogs(t *testing.T) {
	padding := strings.Repeat("x", 9<<20)
	cases := []struct{ id, request, response, want string }{
		{"large-normal", `{"input":"` + padding + `"}`, `{"output":[]}`, "normal"},
		{"large-trigger", `{"input":[{"role":"user","content":"` + padding + `"},{"type":"compaction_trigger"}]}`, `{"error":{"message":"failed"}}`, "compact"},
		{"large-output", `{"input":"hello"}`, `{"padding":"` + padding + `","output":[{"type":"compaction","encrypted_content":"test"}]}`, "compact"},
		{"canceled", `{"input":"hello"}`, "", "unknown"},
	}
	for _, remote := range []bool{false, true} {
		for _, tc := range cases {
			name := "local/" + tc.id
			if remote {
				name = "remote/" + tc.id
			}
			t.Run(name, func(t *testing.T) {
				dir := t.TempDir()
				s, err := sqlite.Open(sqlite.Config{Path: filepath.Join(dir, "usage.db")})
				if err != nil {
					t.Fatal(err)
				}
				defer s.Close()
				ctx := context.Background()
				_, _, err = s.InsertUsageEvents(ctx, []storage.UsageEvent{{EventKey: tc.id, RequestID: tc.id, Timestamp: time.Now()}})
				if err != nil {
					t.Fatal(err)
				}
				body := "=== REQUEST BODY ===\n" + tc.request + "\n=== RESPONSE ===\nStatus: 200\n\n" + tc.response + "\n"
				deps := UsageDeps{Store: s, LogReader: &cpa.LogReader{Dir: dir}}
				if remote {
					deps.LogDownloader = requestLogDownloaderFunc(func(_ context.Context, _ string, w io.Writer) (cpa.RequestLogMeta, error) {
						n, err := io.WriteString(w, body)
						return cpa.RequestLogMeta{Size: int64(n)}, err
					})
				} else if err := os.WriteFile(filepath.Join(dir, "responses-"+tc.id+".log"), []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
				if err := discoverRequestKind(ctx, deps, tc.id); err != nil {
					t.Fatal(err)
				}
				kinds, err := s.RequestKinds(ctx, []string{tc.id})
				if err != nil {
					t.Fatal(err)
				}
				if kinds[tc.id].Kind != tc.want {
					t.Fatalf("got %s, want %s", kinds[tc.id].Kind, tc.want)
				}
			})
		}
	}
}

// Optional read-only reproduction against the user's original downloaded logs.
// Only filenames and classifications are logged; raw request data is not copied.
func TestRequestKindDownloadedSamples(t *testing.T) {
	dir := os.Getenv("CPA_REQUEST_KIND_SAMPLE_DIR")
	if dir == "" {
		t.Skip("CPA_REQUEST_KIND_SAMPLE_DIR is not set")
	}
	s, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "usage.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	for _, tc := range []struct{ id, want string }{{"33bb917d", "normal"}, {"668df86a", "normal"}, {"7ee7a589", "unknown"}} {
		_, _, err := s.InsertUsageEvents(ctx, []storage.UsageEvent{{EventKey: tc.id, RequestID: tc.id, Timestamp: time.Now()}})
		if err != nil {
			t.Fatal(err)
		}
		if err := discoverRequestKind(ctx, UsageDeps{Store: s, LogReader: &cpa.LogReader{Dir: dir}}, tc.id); err != nil {
			t.Fatal(err)
		}
		kinds, err := s.RequestKinds(ctx, []string{tc.id})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%s: %s", tc.id, kinds[tc.id].Kind)
		if kinds[tc.id].Kind != tc.want {
			t.Errorf("%s: got %s, want %s", tc.id, kinds[tc.id].Kind, tc.want)
		}
	}
}
