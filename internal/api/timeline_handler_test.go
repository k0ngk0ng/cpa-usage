package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/k0ngk0ng/cpa-usage/internal/auth"
	"github.com/k0ngk0ng/cpa-usage/internal/pricing"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/storage/sqlite"
	"github.com/k0ngk0ng/cpa-usage/internal/usage"
)

func TestTimelineAPIValidationAuthAndDecoration(t *testing.T) {
	store, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "api.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	rawKey := "sk-private-test-key"
	_, _, err = store.InsertUsageEvents(ctx, []storage.UsageEvent{{EventKey: "one", RequestID: "legacy", Timestamp: time.Now().UTC(), APIGroupKey: rawKey, APIKey: rawKey, Source: "someone@example.com", SessionID: "session", ParentSessionID: "parent", ExecutionID: "execution", Model: "test", LatencyMs: 1500, TotalTokens: 12}})
	if err != nil {
		t.Fatal(err)
	}
	if err = store.UpsertAPIKeyAlias(ctx, storage.APIKeyAlias{APIKey: rawKey, Alias: "Team A"}); err != nil {
		t.Fatal(err)
	}
	service := usage.New(store, pricing.New(store), usage.NewDisplayResolver(store))
	tokens := auth.NewTokenManager(time.Hour, "test-password")
	cfg := RouterConfig{BasePath: "/usage", Auth: AuthDeps{Enabled: true, CookieName: "test-session", Tokens: tokens}, Usage: UsageDeps{Service: service, Store: store}, Meta: MetaDeps{Store: store}}
	router := New(cfg)
	for _, path := range []string{"/usage/api/v1/usage/sessions/label?session_id=session", "/usage/api/v1/usage/timelines/session-requests?session_id=session&snapshot=1", "/usage/api/v1/usage/timelines", "/usage/api/v1/usage/timelines/detail?key=request:legacy"} {
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != 401 {
			t.Fatalf("unguarded %s: %d", path, rr.Code)
		}
	}
	token, _, err := tokens.Create()
	if err != nil {
		t.Fatal(err)
	}
	call := func(query string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET", "/usage/api/v1/usage/"+query, nil)
		req.Header.Set("Cookie", "test-session="+token)
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr
	}
	for _, query := range []string{"timelines/session-requests", "timelines/session-requests?session_id=session&snapshot=0", "timelines/session-requests?session_id=session&snapshot=1&page=-1", "timelines/session-requests?session_id=session&snapshot=1&page=bad", "timelines?mode=invalid", "timelines?page=-1", "timelines?page=hello", "timelines?range=custom&start=bad&end=bad", "timelines/detail?key=request:", "timelines/detail?key=unknown:a", "timelines/detail?key=request:a&cursor=1", "timelines/detail?key=request:a&cursor=bad", "timelines/detail?key=request:a&snapshot=-1"} {
		if rr := call(query); rr.Code != 400 {
			t.Errorf("%s: %d %s", query, rr.Code, rr.Body.String())
		}
	}
	if rr := call("timelines/detail?key=request:missing"); rr.Code != 404 {
		t.Fatalf("missing: %d %s", rr.Code, rr.Body.String())
	}
	for _, filter := range []string{"trace_id=legacy", "execution_id=execution", "session_id=session", "parent_session_id=parent"} {
		rr := call("timelines?range=all&" + filter)
		var page storage.TimelinePage
		if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil || rr.Code != 200 || page.Total != 1 {
			t.Fatalf("filter %s: %d %s", filter, rr.Code, rr.Body.String())
		}
	}
	rr := call("timelines/detail?" + url.Values{"key": {"request:legacy"}, "focus_event": {"one"}}.Encode())
	if rr.Code != 200 {
		t.Fatalf("detail: %d %s", rr.Code, rr.Body.String())
	}
	var detail storage.TimelineDetail
	if err := json.Unmarshal(rr.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Items) != 1 || detail.Items[0].APIGroupDisplay != "Team A" || detail.Items[0].ExecutionID != "execution" {
		t.Fatalf("detail decoration: %+v", detail.Items)
	}
	if detail.FocusedEvent == nil || detail.FocusedEvent.APIGroupDisplay != "Team A" {
		t.Fatalf("focused event not decorated: %+v", detail.FocusedEvent)
	}
	if strings.Contains(rr.Body.String(), rawKey) {
		t.Fatal("raw API key leaked in timeline response")
	}
	rr = call("timelines/detail?key=session:parent")
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"referenced_only":true`) {
		t.Fatalf("parent response: %d %s", rr.Code, rr.Body.String())
	}
	rr = call("timelines/session-requests?session_id=session&snapshot=1&page=0&focus_key=request:legacy")
	var requests storage.TimelinePage
	if err := json.Unmarshal(rr.Body.Bytes(), &requests); err != nil || rr.Code != 200 || requests.Total != 1 || requests.Items[0].Key != "request:legacy" {
		t.Fatalf("session requests: %d %s", rr.Code, rr.Body.String())
	}
}
