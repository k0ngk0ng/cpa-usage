package cpa

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
)

const maxInlineAssetEncodedBytes int64 = 256 << 20

var (
	errLogSectionNotFound = errors.New("log section not found")
	errLogSectionTooLarge = errors.New("log section too large")
)

type inlineAssetReplacement struct {
	start int
	end   int
	url   string
}

// ReadForDisplay reads a log entry and replaces supported inline Base64 assets
// in the request JSON with lazy same-origin URLs. The compacted body stays
// valid JSON and is only used when it fits within MaxBodyBytes.
func (r *LogReader) ReadForDisplay(path, assetURL string) (*LogEntry, error) {
	entry, err := r.Read(path)
	if err != nil || strings.TrimSpace(assetURL) == "" {
		return entry, err
	}

	raw, bodyOffset, err := readLogSection(path, "REQUEST BODY")
	if err != nil {
		if errors.Is(err, errLogSectionNotFound) || errors.Is(err, errLogSectionTooLarge) {
			return entry, nil
		}
		return nil, err
	}
	compacted, assetCount, ok := externalizeInlineAssets(raw, bodyOffset, assetURL)
	if !ok || assetCount == 0 {
		return entry, nil
	}

	maxBody := r.MaxBodyBytes
	if maxBody <= 0 {
		maxBody = 1 << 20
	}
	if int64(len(compacted)) > maxBody {
		return entry, nil
	}

	entry.RequestBody = strings.TrimRight(string(compacted), "\r\n")
	entry.RequestTruncated = false
	return entry, nil
}

// ReadInlineAsset decodes one Base64 payload referenced by a compacted log
// body. Offsets are absolute within the original immutable CPA log file.
func (r *LogReader) ReadInlineAsset(path string, offset, encodedLength int64) ([]byte, string, error) {
	if offset < 0 || encodedLength <= 0 || encodedLength > maxInlineAssetEncodedBytes {
		return nil, "", fmt.Errorf("invalid inline asset range")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, "", err
	}
	if offset > st.Size() || encodedLength > st.Size()-offset {
		return nil, "", fmt.Errorf("inline asset range exceeds log size")
	}

	encoded := make([]byte, encodedLength)
	if _, err := io.ReadFull(io.NewSectionReader(f, offset, encodedLength), encoded); err != nil {
		return nil, "", err
	}
	decoded, err := decodeInlineAssetBase64(encoded)
	if err != nil {
		return nil, "", fmt.Errorf("decode inline asset: %w", err)
	}
	mimeType := inlineAssetMIME(decoded)
	if mimeType == "" {
		return nil, "", fmt.Errorf("inline payload is not a supported asset")
	}
	return decoded, mimeType, nil
}

func readLogSection(path, target string) ([]byte, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	reader := bufio.NewReaderSize(f, 64*1024)
	var body bytes.Buffer
	var position int64
	var bodyOffset int64
	found := false

	for {
		line, readErr := reader.ReadString('\n')
		lineStart := position
		position += int64(len(line))
		if line != "" {
			trimmed := strings.TrimRight(line, "\r\n")
			if marker, ok := parseSectionMarker(trimmed); ok {
				if found {
					return body.Bytes(), bodyOffset, nil
				}
				if marker == target {
					found = true
					bodyOffset = position
				}
			} else if found {
				if int64(body.Len())+int64(len(line)) > maxInlineAssetEncodedBytes {
					return nil, 0, errLogSectionTooLarge
				}
				if body.Len() == 0 {
					bodyOffset = lineStart
				}
				body.WriteString(line)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				if found {
					return body.Bytes(), bodyOffset, nil
				}
				return nil, 0, errLogSectionNotFound
			}
			return nil, 0, readErr
		}
	}
}

func externalizeInlineAssets(raw []byte, bodyOffset int64, assetURL string) ([]byte, int, bool) {
	replacements, ok := scanJSONInlineAssets(raw, bodyOffset, assetURL)
	if !ok || len(replacements) == 0 {
		return raw, 0, ok
	}
	sort.Slice(replacements, func(i, j int) bool { return replacements[i].start < replacements[j].start })

	estimatedSize := len(raw)
	for _, replacement := range replacements {
		estimatedSize += len(replacement.url) - (replacement.end - replacement.start)
	}
	if estimatedSize < 0 {
		estimatedSize = 0
	}
	var compacted bytes.Buffer
	compacted.Grow(estimatedSize)
	cursor := 0
	applied := 0
	for _, replacement := range replacements {
		if replacement.start < cursor || replacement.end < replacement.start || replacement.end > len(raw) {
			continue
		}
		compacted.Write(raw[cursor:replacement.start])
		compacted.WriteString(replacement.url)
		cursor = replacement.end
		applied++
	}
	compacted.Write(raw[cursor:])
	return compacted.Bytes(), applied, true
}

func scanJSONInlineAssets(raw []byte, bodyOffset int64, assetURL string) ([]inlineAssetReplacement, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()

	type frame struct {
		delim      json.Delim
		expectsKey bool
		key        string
	}
	stack := make([]frame, 0, 8)
	replacements := make([]inlineAssetReplacement, 0, 4)
	rootValues := 0

	consumeValue := func() bool {
		if len(stack) == 0 {
			rootValues++
			return rootValues == 1
		}
		top := &stack[len(stack)-1]
		if top.delim == '{' {
			if top.expectsKey {
				return false
			}
			top.expectsKey = true
			top.key = ""
		}
		return true
	}

	for {
		token, err := decoder.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return replacements, len(stack) == 0 && rootValues == 1
			}
			return nil, false
		}
		endOffset := int(decoder.InputOffset())

		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{', '[':
				if !consumeValue() {
					return nil, false
				}
				stack = append(stack, frame{delim: value, expectsKey: value == '{'})
			case '}', ']':
				if len(stack) == 0 || stack[len(stack)-1].delim != matchingOpenDelimiter(value) {
					return nil, false
				}
				if value == '}' && !stack[len(stack)-1].expectsKey {
					return nil, false
				}
				stack = stack[:len(stack)-1]
			}
		case string:
			if len(stack) > 0 {
				top := &stack[len(stack)-1]
				if top.delim == '{' && top.expectsKey {
					top.key = value
					top.expectsKey = false
					continue
				}
			}

			key := ""
			if len(stack) > 0 && stack[len(stack)-1].delim == '{' {
				key = stack[len(stack)-1].key
			}
			if !consumeValue() {
				return nil, false
			}
			contentStart, contentEnd, ok := rawStringContentBounds(raw, endOffset, value)
			if !ok {
				continue
			}

			if payloadStart, mimeType, ok := dataInlineAssetPayload(value); ok {
				encodedOffset := bodyOffset + int64(contentStart+payloadStart)
				encodedLength := int64(len(value) - payloadStart)
				replacements = append(replacements, inlineAssetReplacement{
					start: contentStart,
					end:   contentEnd,
					url:   buildInlineAssetURL(assetURL, encodedOffset, encodedLength, mimeType),
				})
				continue
			}
			if !isInlineAssetDataKey(key) {
				continue
			}
			mimeType := base64InlineAssetMIME(value)
			if mimeType == "" {
				continue
			}
			encodedOffset := bodyOffset + int64(contentStart)
			encodedLength := int64(len(value))
			replacements = append(replacements, inlineAssetReplacement{
				start: contentStart,
				end:   contentEnd,
				url:   buildInlineAssetURL(assetURL, encodedOffset, encodedLength, mimeType),
			})
		default:
			if !consumeValue() {
				return nil, false
			}
		}
	}
}

func matchingOpenDelimiter(close json.Delim) json.Delim {
	if close == '}' {
		return '{'
	}
	return '['
}

func rawStringContentBounds(raw []byte, tokenEnd int, value string) (int, int, bool) {
	contentEnd := tokenEnd - 1
	contentStart := contentEnd - len(value)
	if contentStart <= 0 || contentEnd >= len(raw) || raw[contentStart-1] != '"' || raw[contentEnd] != '"' {
		return 0, 0, false
	}
	return contentStart, contentEnd, true
}

func dataInlineAssetPayload(value string) (int, string, bool) {
	comma := strings.IndexByte(value, ',')
	if comma <= 0 || comma == len(value)-1 {
		return 0, "", false
	}
	metadata := strings.ToLower(value[:comma])
	if !strings.HasPrefix(metadata, "data:") || !strings.HasSuffix(metadata, ";base64") {
		return 0, "", false
	}
	payloadStart := comma + 1
	mimeType := base64InlineAssetMIME(value[payloadStart:])
	if mimeType == "" {
		return 0, "", false
	}
	return payloadStart, mimeType, true
}

func isInlineAssetDataKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(key, "_", ""))
	switch normalized {
	case "data", "filedata", "b64json", "result", "partial", "partialimageb64", "imagedata", "screenshot":
		return true
	default:
		return strings.Contains(normalized, "image") && strings.Contains(normalized, "data")
	}
}

func base64InlineAssetMIME(value string) string {
	if len(value) < 16 {
		return ""
	}
	sampleLength := len(value)
	if sampleLength > 128 {
		sampleLength = 128
	}
	if sampleLength < len(value) {
		sampleLength -= sampleLength % 4
	}
	if sampleLength == 0 {
		return ""
	}
	sample, err := decodeInlineAssetBase64([]byte(value[:sampleLength]))
	if err != nil {
		return ""
	}
	return inlineAssetMIME(sample)
}

func decodeInlineAssetBase64(encoded []byte) ([]byte, error) {
	decoded := make([]byte, base64.StdEncoding.DecodedLen(len(encoded)))
	n, err := base64.StdEncoding.Decode(decoded, encoded)
	if err == nil {
		return decoded[:n], nil
	}
	decoded = make([]byte, base64.RawStdEncoding.DecodedLen(len(encoded)))
	n, rawErr := base64.RawStdEncoding.Decode(decoded, encoded)
	if rawErr == nil {
		return decoded[:n], nil
	}
	return nil, err
}

func rasterImageMIME(data []byte) string {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg"
	case len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))):
		return "image/gif"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	default:
		return ""
	}
}

func inlineAssetMIME(data []byte) string {
	if mimeType := rasterImageMIME(data); mimeType != "" {
		return mimeType
	}
	if len(data) >= 5 && bytes.Equal(data[:5], []byte("%PDF-")) {
		return "application/pdf"
	}
	return ""
}

func buildInlineAssetURL(base string, offset, length int64, mimeType string) string {
	query := url.Values{}
	query.Set("length", strconv.FormatInt(length, 10))
	query.Set("mime", mimeType)
	query.Set("offset", strconv.FormatInt(offset, 10))
	separator := "?"
	if strings.Contains(base, "?") {
		separator = "&"
	}
	return base + separator + query.Encode()
}
