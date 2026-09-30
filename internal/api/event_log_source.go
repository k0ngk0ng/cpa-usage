package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/k0ngk0ng/cpa-usage/internal/cpa"
)

var (
	errEventLogSourceUnavailable = errors.New("request log source is not configured")
	errEventLogAssetFetch        = errors.New("fetch request log asset")
)

type eventLogHandle struct {
	path     string
	fileName string
	fileSize int64
	cleanup  func()
}

func (h *eventLogHandle) Close() {
	if h != nil && h.cleanup != nil {
		h.cleanup()
	}
}

func (h *eventLogHandle) ApplyMetadata(entry *cpa.LogEntry) {
	if h == nil || entry == nil {
		return
	}
	if h.fileName != "" {
		entry.File = h.fileName
	}
	if h.fileSize > 0 {
		entry.FileSizeBytes = h.fileSize
	}
}

func eventLogSourceConfigured(deps UsageDeps) bool {
	return deps.LogDownloader != nil || (deps.LogReader != nil && strings.TrimSpace(deps.LogReader.Dir) != "")
}

func resolveEventLog(ctx context.Context, deps UsageDeps, requestID string, maxBytes ...int64) (*eventLogHandle, error) {
	localLog, err := resolveLocalEventLog(deps, requestID)
	if err == nil {
		return localLog, nil
	}
	if !errors.Is(err, cpa.ErrLogNotFound) {
		return nil, err
	}

	if deps.LogDownloader == nil {
		if !eventLogSourceConfigured(deps) {
			return nil, errEventLogSourceUnavailable
		}
		return nil, cpa.ErrLogNotFound
	}

	tmp, err := os.CreateTemp("", "cpa-request-log-*.log")
	if err != nil {
		return nil, fmt.Errorf("create request log temp file: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) }

	var destination io.Writer = tmp
	if len(maxBytes) > 0 && maxBytes[0] > 0 {
		destination = &boundedLogWriter{writer: tmp, remaining: maxBytes[0]}
	}
	meta, downloadErr := deps.LogDownloader.DownloadRequestLog(ctx, requestID, destination)
	closeErr := tmp.Close()
	if downloadErr != nil {
		cleanup()
		return nil, downloadErr
	}
	if closeErr != nil {
		cleanup()
		return nil, fmt.Errorf("close request log temp file: %w", closeErr)
	}

	fileName := strings.TrimSpace(meta.FileName)
	if fileName == "" {
		fileName = "request-log-" + requestID + ".log"
	}
	return &eventLogHandle{
		path:     tmpPath,
		fileName: filepath.Base(fileName),
		fileSize: meta.Size,
		cleanup:  cleanup,
	}, nil
}

func resolveLocalEventLog(deps UsageDeps, requestID string) (*eventLogHandle, error) {
	if err := cpa.ValidateRequestID(requestID); err != nil {
		return nil, err
	}
	if deps.LogReader == nil || strings.TrimSpace(deps.LogReader.Dir) == "" {
		return nil, cpa.ErrLogNotFound
	}
	localPath, err := deps.LogReader.FindLog(requestID)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(localPath)
	if err != nil {
		return nil, err
	}
	return &eventLogHandle{
		path:     localPath,
		fileName: filepath.Base(localPath),
		fileSize: info.Size(),
	}, nil
}

func readEventLogAsset(ctx context.Context, deps UsageDeps, requestID string, offset, length int64) ([]byte, string, error) {
	if err := cpa.ValidateInlineAssetRange(offset, length); err != nil {
		return nil, "", err
	}

	localLog, err := resolveLocalEventLog(deps, requestID)
	if err == nil {
		defer localLog.Close()
		return eventLogReader(deps).ReadInlineAsset(localLog.path, offset, length)
	}
	if !errors.Is(err, cpa.ErrLogNotFound) {
		return nil, "", err
	}

	if downloader, ok := deps.LogDownloader.(cpa.RequestLogRangeDownloader); ok {
		var encoded bytes.Buffer
		if _, err = downloader.DownloadRequestLogRange(ctx, requestID, offset, length, &encoded); err != nil {
			return nil, "", fmt.Errorf("%w: %w", errEventLogAssetFetch, err)
		}
		return cpa.DecodeInlineAsset(encoded.Bytes())
	}

	remoteLog, err := resolveEventLog(ctx, deps, requestID)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %w", errEventLogAssetFetch, err)
	}
	defer remoteLog.Close()
	return eventLogReader(deps).ReadInlineAsset(remoteLog.path, offset, length)
}

func eventLogReader(deps UsageDeps) *cpa.LogReader {
	if deps.LogReader != nil {
		return deps.LogReader
	}
	return &cpa.LogReader{}
}

// Abort oversized background downloads instead of buffering complete transcripts.
type boundedLogWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *boundedLogWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, errors.New("request log exceeds title discovery size limit")
	}
	n, err := w.writer.Write(p)
	w.remaining -= int64(n)
	return n, err
}
