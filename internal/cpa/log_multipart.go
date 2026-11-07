package cpa

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/url"
	"strconv"
	"strings"
)

// Multipart image uploads contain binary bytes that cannot round-trip through
// a JSON string. Keep their display metadata separate from the logged body,
// and serve previews from the original immutable file.
type ImageRequest struct {
	Fields []ImageFormField `json:"fields"`
	Files  []ImageUpload    `json:"files"`
}

type ImageFormField struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type ImageUpload struct {
	Name     string `json:"name"`
	Filename string `json:"filename"`
	MIMEType string `json:"mime_type,omitempty"`
	URL      string `json:"url,omitempty"`
}

// Images API calls cannot perform context compaction, irrespective of their
// model name or whether the uploaded body is JSON or multipart.
func IsImageEndpoint(endpoint string) bool {
	u, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil {
		return false
	}
	path := strings.TrimSuffix(u.Path, "/")
	return strings.HasSuffix(path, "/images/edits") || strings.HasSuffix(path, "/images/generations") || strings.HasSuffix(path, "/images/variations")
}

func multipartImageRequest(raw []byte, offset int64, contentType, assetURL string) *ImageRequest {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "multipart/form-data" || params["boundary"] == "" {
		return nil
	}
	reader := multipart.NewReader(bytes.NewReader(raw), params["boundary"])
	result := &ImageRequest{Fields: []ImageFormField{}, Files: []ImageUpload{}}
	cursor := 0
	boundary := []byte("--" + params["boundary"])
	for {
		part, err := reader.NextRawPart()
		if errors.Is(err, io.EOF) {
			return result
		}
		if err != nil {
			return nil // Incomplete/malformed uploads retain the raw fallback.
		}
		data, err := io.ReadAll(part)
		if err != nil {
			return nil
		}
		// Search forward through each part's header before locating its body.
		// This distinguishes repeated uploads with identical file contents.
		start := bytes.Index(raw[cursor:], boundary)
		if start < 0 {
			return nil
		}
		start += cursor + len(boundary)
		headerEnd := bytes.Index(raw[start:], []byte("\r\n\r\n"))
		if headerEnd < 0 {
			return nil
		}
		start += headerEnd + 4
		if len(data) > len(raw)-start || !bytes.Equal(raw[start:start+len(data)], data) {
			return nil
		}
		cursor = start + len(data)
		if part.FileName() == "" {
			result.Fields = append(result.Fields, ImageFormField{Name: part.FormName(), Value: string(data)})
			continue
		}
		file := ImageUpload{Name: part.FormName(), Filename: part.FileName(), MIMEType: rasterImageMIME(data)}
		if file.MIMEType != "" {
			query := url.Values{"offset": {strconv.FormatInt(offset+int64(start), 10)}, "length": {strconv.Itoa(len(data))}, "encoding": {"raw"}}
			separator := "?"
			if strings.Contains(assetURL, "?") {
				separator = "&"
			}
			file.URL = assetURL + separator + query.Encode()
		}
		result.Files = append(result.Files, file)
	}
}
