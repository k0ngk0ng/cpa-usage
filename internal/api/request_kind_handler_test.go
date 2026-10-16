package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
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
