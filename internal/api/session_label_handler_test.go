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
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/storage/sqlite"
)

func TestSessionLabelAPIReadsCachesAndScopesNamingLog(t *testing.T) {
	store, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "labels.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	now := time.Now().UTC()
	if _, _, err := store.InsertUsageEvents(ctx, []storage.UsageEvent{{EventKey: "a", RequestID: "preview", SessionID: "s", ParentSessionID: "parent", Timestamp: now}, {EventKey: "b", RequestID: "name", SessionID: "s", Timestamp: now.Add(time.Second)}}); err != nil {
		t.Fatal(err)
	}
	logs := map[string]string{
		"preview": "=== REQUEST BODY ===\n{\"input\":\"Fix login\"}\n\n=== RESPONSE ===\nStatus: 200\n\n{\"output_text\":\"Done\"}\n",
		"name":    "=== REQUEST BODY ===\n{\"instructions\":\"Generate a concise title for this session.\",\"input\":\"Fix login\"}\n\n=== RESPONSE ===\nStatus: 200\n\n{\"output_text\":\"登录修复\"}\n",
	}
	calls := 0
	deps := UsageDeps{Store: store, LogDownloader: requestLogDownloaderFunc(func(_ context.Context, id string, w io.Writer) (cpa.RequestLogMeta, error) {
		calls++
		_, err := io.WriteString(w, logs[id])
		return cpa.RequestLogMeta{FileName: id + ".log", Size: int64(len(logs[id]))}, err
	})}
	r := gin.New()
	r.GET("/label", usageSessionLabelHandler(deps))
	call := func(query string) (int, storage.SessionLabel) {
		t.Helper()
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, httptest.NewRequest("GET", "/label"+query, nil))
		var out storage.SessionLabel
		if rr.Code == 200 {
			if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
		}
		return rr.Code, out
	}
	code, label := call("?session_id=s&cached=1")
	if code != 200 || label.Title != "" || calls != 0 {
		t.Fatal("cache read performed discovery")
	}
	code, label = call("?session_id=s")
	if code != 200 || label.Title != "登录修复" || label.Source != "generated_title" || label.RequestID != "name" || label.More {
		t.Fatalf("label: %d %+v", code, label)
	}
	if calls != 2 {
		t.Fatalf("downloads: %d", calls)
	}
	_, label = call("?session_id=s&cached=1")
	if label.Title != "登录修复" || calls != 2 {
		t.Fatal("persisted name not available independently of log discovery")
	}

	_, label = call("?session_id=s")
	if label.Title != "登录修复" || calls != 2 {
		t.Fatal("cached logs downloaded again")
	}
	for _, id := range []string{"parent", "unknown"} {
		_, label = call("?session_id=" + id)
		if label.Title != "" || calls != 2 {
			t.Fatal("unrelated logs read")
		}
	}
	if code, _ = call(""); code != 400 {
		t.Fatalf("invalid query: %d", code)
	}
}
func TestSessionLabelMissingLogDoesNotFailSessionOrLoop(t *testing.T) {
	store, err := sqlite.Open(sqlite.Config{Path: filepath.Join(t.TempDir(), "labels.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, _, err = store.InsertUsageEvents(context.Background(), []storage.UsageEvent{{EventKey: "a", RequestID: "missing", SessionID: "s", Timestamp: time.Now()}})
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	deps := UsageDeps{Store: store, LogDownloader: requestLogDownloaderFunc(func(context.Context, string, io.Writer) (cpa.RequestLogMeta, error) {
		calls++
		return cpa.RequestLogMeta{}, cpa.ErrLogNotFound
	})}
	r := gin.New()
	r.GET("/label", usageSessionLabelHandler(deps))
	for i := 0; i < 2; i++ {
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, httptest.NewRequest("GET", "/label?session_id=s", nil))
		if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"more":false`) {
			t.Fatalf("missing log: %d %s", rr.Code, rr.Body.String())
		}
	}
	if calls != 1 {
		t.Fatalf("no retry cooldown: %d", calls)
	}
}
func TestBackgroundLogDownloadHasByteLimit(t *testing.T) {
	var written int
	deps := UsageDeps{LogDownloader: requestLogDownloaderFunc(func(_ context.Context, _ string, w io.Writer) (cpa.RequestLogMeta, error) {
		n, err := w.Write([]byte("123456789"))
		written += n
		return cpa.RequestLogMeta{}, err
	})}
	if handle, err := resolveEventLog(context.Background(), deps, "safe-id", 8); err == nil {
		handle.Close()
		t.Fatal("oversized log accepted")
	}
	if written != 0 {
		t.Fatal("oversized block written")
	}
}
