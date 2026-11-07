// Real API/SQLite/log-reader fixture for images.mjs. No provider calls.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/k0ngk0ng/cpa-usage/internal/api"
	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
	"github.com/k0ngk0ng/cpa-usage/internal/pricing"
	"github.com/k0ngk0ng/cpa-usage/internal/storage"
	"github.com/k0ngk0ng/cpa-usage/internal/storage/sqlite"
	"github.com/k0ngk0ng/cpa-usage/internal/usage"
)

type scenario struct {
	ID           string   `json:"id"`
	Inputs       []string `json:"inputs"`
	Outputs      []string `json:"outputs"`
	FinalOutputs []string `json:"final_outputs"`
	Model        string   `json:"model"`
}

func main() {
	dir := os.Getenv("IMAGES_E2E_DIR")
	if dir == "" {
		panic("IMAGES_E2E_DIR required")
	}
	must(os.MkdirAll(filepath.Join(dir, "logs"), 0700))
	s, err := sqlite.Open(sqlite.Config{Path: filepath.Join(dir, "usage.db")})
	must(err)
	defer s.Close()
	a, b := picture(false), picture(true)
	encoded := base64.StdEncoding.EncodeToString(a)
	response := `{"output_format":"png","data":[{"b64_json":"` + encoded + `"},{"b64_json":"` + encoded + `"}]}`
	var form bytes.Buffer
	w := multipart.NewWriter(&form)
	for _, f := range [][2]string{{"model", "gpt-image-2.5"}, {"prompt", "Preserve the character.\n参考图保持一致。"}, {"quality", "high"}, {"size", "1024x1536"}} {
		must(w.WriteField(f[0], f[1]))
	}
	for i, name := range []string{"image[]", "image[]", "mask"} {
		p, err := w.CreateFormFile(name, []string{"reference-a.png", "reference-b.jpg", "mask.png"}[i])
		must(err)
		data := a
		if i == 1 {
			data = b
		}
		_, err = p.Write(data)
		must(err)
	}
	must(w.Close())
	var cases []scenario
	add := func(id, endpoint, contentType string, request []byte, result string, inputs, outputs [][]byte) {
		body := append([]byte("=== REQUEST INFO ===\nURL: "+endpoint+"\nMethod: POST\n=== HEADERS ===\nContent-Type: "+contentType+"\n=== REQUEST BODY ===\n"), request...)
		body = append(body, []byte("\n=== API RESPONSE 1 ===\nStatus: 200\nBody:\n"+result+"\n=== RESPONSE ===\nStatus: 200\nContent-Type: application/json\n\n"+result+"\n")...)
		must(os.WriteFile(filepath.Join(dir, "logs", "images-"+id+".log"), body, 0600))
		c := scenario{ID: id, Model: "gpt-image-2.5", Inputs: []string{}, Outputs: []string{}, FinalOutputs: []string{}}
		for _, data := range inputs {
			c.Inputs = append(c.Inputs, digest(data))
		}
		for _, data := range outputs {
			c.Outputs = append(c.Outputs, digest(data))
			c.FinalOutputs = append(c.FinalOutputs, digest(data))
		}
		cases = append(cases, c)
		_, _, err := s.InsertUsageEvents(context.Background(), []storage.UsageEvent{{EventKey: id, RequestID: id, Model: c.Model, Endpoint: endpoint, Timestamp: time.Now(), Generate: true, TotalTokens: 42}})
		must(err)
	}
	add("multipart", "/v1/images/edits", w.FormDataContentType(), form.Bytes(), response, [][]byte{a, b, a}, [][]byte{a, a})
	add("generation", "/v1/images/generations", "application/json", []byte(`{"model":"gpt-image-2.5","prompt":"Generate a new image","output_format":"jpeg"}`), `{"output_format":"jpeg","data":[{"b64_json":"`+base64.StdEncoding.EncodeToString(b)+`"}]}`, nil, [][]byte{b})
	add("json-edit", "/v1/images/edits", "application/json", []byte(`{"model":"gpt-image-2.5","prompt":"Edit JSON image references","images":[{"image_url":"data:image/png;base64,`+encoded+`"},{"file_id":"file-reference-only"}],"mask":{"image_url":"data:image/png;base64,`+encoded+`"}}`), `{"data":[{"url":"http://127.0.0.1:18329/fixture.png","revised_prompt":"Revised image prompt"}]}`, [][]byte{a, a}, [][]byte{a})
	add("stream", "/v1/images/generations", "application/json", []byte(`{"model":"gpt-image-2.5","prompt":"Stream the image","stream":true}`), "event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\",\"partial_image_index\":0,\"b64_json\":\""+encoded+"\"}\n\nevent: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"output_format\":\"png\",\"b64_json\":\""+encoded+"\"}\n", nil, [][]byte{a})
	add("failed", "/v1/images/edits", w.FormDataContentType(), form.Bytes(), `{"error":{"message":"Image generation blocked"}}`, [][]byte{a, b, a}, nil)
	add("unsafe", "/v1/images/generations", "application/json", []byte(`{"model":"gpt-image-2.5","prompt":"Invalid output"}`), `{"data":[{"url":"javascript:alert(1)"},{"b64_json":"not-an-image"}]}`, nil, nil)
	add("malformed", "/v1/images/edits", "multipart/form-data; boundary=missing", []byte("incomplete multipart upload"), `{"error":{"message":"Invalid multipart request"}}`, nil, nil)
	add("partial", "/v1/images/generations", "application/json", []byte(`{"model":"gpt-image-2.5","prompt":"Interrupted image stream"}`), "data: {\"type\":\"image_generation.partial_image\",\"partial_image_index\":0,\"b64_json\":\""+encoded+"\"}\n", nil, [][]byte{a})
	add("delivery-error", "/v1/images/generations", "application/json", []byte(`{"model":"gpt-image-2.5","prompt":"Final delivery failed"}`), response, nil, [][]byte{a, a})
	lastCase := &cases[len(cases)-1]
	lastCase.FinalOutputs = []string{}
	path := filepath.Join(dir, "logs", "images-delivery-error.log")
	content, err := os.ReadFile(path)
	must(err)
	marker := []byte("=== RESPONSE ===\n")
	i := bytes.LastIndex(content, marker)
	content = append(content[:i+len(marker)], []byte("Status: 502\n\n{\"error\":{\"message\":\"Final delivery failed\"}}\n")...)
	must(os.WriteFile(path, content, 0600))
	if sample := os.Getenv("CPA_IMAGE_SAMPLE_LOG"); sample != "" {
		body, err := os.ReadFile(sample)
		must(err)
		start := bytes.Index(body, []byte("=== REQUEST BODY ===\n")) + len("=== REQUEST BODY ===\n")
		end := bytes.Index(body[start:], []byte("\n=== API REQUEST")) + start
		var inputs [][]byte
		header := string(body[:start])
		i := strings.Index(strings.ToLower(header), "content-type:")
		line := strings.SplitN(header[i:], "\n", 2)[0]
		_, params, err := mime.ParseMediaType(strings.TrimSpace(strings.SplitN(line, ":", 2)[1]))
		must(err)
		r := multipart.NewReader(bytes.NewReader(body[start:end]), params["boundary"])
		for {
			p, err := r.NextPart()
			if err != nil {
				break
			}
			if p.FileName() != "" {
				var data bytes.Buffer
				_, err = data.ReadFrom(p)
				must(err)
				inputs = append(inputs, data.Bytes())
			}
		}
		last := bytes.LastIndex(body, []byte("=== RESPONSE ===\n")) + len("=== RESPONSE ===\n")
		last += bytes.Index(body[last:], []byte("\n\n")) + 2
		var result struct {
			Data []struct {
				B64 string `json:"b64_json"`
			} `json:"data"`
		}
		must(json.Unmarshal(bytes.TrimSpace(body[last:]), &result))
		var outputs [][]byte
		for _, item := range result.Data {
			data, err := base64.StdEncoding.DecodeString(item.B64)
			must(err)
			outputs = append(outputs, data)
		}
		must(os.WriteFile(filepath.Join(dir, "logs", "images-real-sample.log"), body, 0600))
		c := scenario{ID: "real-sample", Model: "gpt-image-2.5", Inputs: []string{}, Outputs: []string{}, FinalOutputs: []string{}}
		for _, data := range inputs {
			c.Inputs = append(c.Inputs, digest(data))
		}
		for _, data := range outputs {
			c.Outputs = append(c.Outputs, digest(data))
			c.FinalOutputs = append(c.FinalOutputs, digest(data))
		}
		cases = append(cases, c)
		_, _, err = s.InsertUsageEvents(context.Background(), []storage.UsageEvent{{EventKey: c.ID, RequestID: c.ID, Model: c.Model, Endpoint: "/v1/images/edits", Timestamp: time.Now(), Generate: true}})
		must(err)
	}
	manifest, err := json.Marshal(cases)
	must(err)
	must(os.WriteFile(filepath.Join(dir, "manifest.json"), manifest, 0600))
	p := pricing.New(s)
	deps := api.UsageDeps{Store: s, Service: usage.New(s, p, usage.NewDisplayResolver(s)), LogReader: &cpa.LogReader{Dir: filepath.Join(dir, "logs")}}
	if os.Getenv("IMAGES_E2E_REMOTE") == "1" {
		remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := strings.TrimPrefix(r.URL.Path, "/v0/management/request-log-by-id/")
			http.ServeFile(w, r, filepath.Join(dir, "logs", "images-"+id+".log"))
		}))
		defer remote.Close()
		deps.LogReader = nil
		deps.LogDownloader = cpa.NewClient(remote.URL, "fixture-key", time.Minute)
	}
	router := api.New(api.RouterConfig{BasePath: "/usage", Usage: deps, Meta: api.MetaDeps{Store: s}, Pricing: api.PricingDeps{Service: p}})
	router.GET("/fixture.png", func(c *gin.Context) { c.Data(200, "image/png", a) })
	fmt.Println("image E2E listening")
	must(http.ListenAndServe("127.0.0.1:18329", router))
}

func picture(jpg bool) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, 96, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 96; x++ {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x * 2), uint8(y * 3), 160, 255})
		}
	}
	var b bytes.Buffer
	if jpg {
		must(jpeg.Encode(&b, img, nil))
	} else {
		must(png.Encode(&b, img))
	}
	return b.Bytes()
}
func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func must(err error) {
	if err != nil {
		panic(err)
	}
}
