package cpa

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ErrRedisAuth is returned when the CPA management key is rejected.
var ErrRedisAuth = errors.New("redis queue auth failed")

// ErrRedisSubscribeUnsupported indicates that the connected CPA build does
// not implement Redis-style usage Pub/Sub. Callers may safely fall back to LPOP.
var ErrRedisSubscribeUnsupported = errors.New("redis usage subscription unsupported")

// RedisQueue speaks the minimal RESP subset CPA needs (AUTH, SUBSCRIBE, LPOP).
// CPA multiplexes RESP and HTTP on the same TCP port (default 8317) by
// inspecting the first byte of each connection.
type RedisQueue struct {
	address       string
	managementKey string
	queueKey      string
	timeout       time.Duration
	batchSize     int
}

// RedisQueueConfig parameterizes RedisQueue construction.
type RedisQueueConfig struct {
	BaseURL       string
	OverrideAddr  string
	ManagementKey string
	QueueKey      string
	Timeout       time.Duration
	BatchSize     int
}

// NewRedisQueue resolves the RESP address and returns a queue client.
func NewRedisQueue(cfg RedisQueueConfig) *RedisQueue {
	queueKey := strings.TrimSpace(cfg.QueueKey)
	if queueKey == "" {
		queueKey = RedisUsageQueueKey
	}
	batch := cfg.BatchSize
	if batch <= 0 {
		batch = 1000
	}
	return &RedisQueue{
		address:       resolveRedisAddress(cfg.BaseURL, cfg.OverrideAddr),
		managementKey: strings.TrimSpace(cfg.ManagementKey),
		queueKey:      queueKey,
		timeout:       cfg.Timeout,
		batchSize:     batch,
	}
}

// Address returns the resolved tcp host:port the queue dials.
func (c *RedisQueue) Address() string { return c.address }

// BatchSize returns the configured persistence batch size.
func (c *RedisQueue) BatchSize() int { return c.batchSize }

// Probe opens an authenticated connection and immediately closes it.
func (c *RedisQueue) Probe(ctx context.Context) error {
	conn, _, err := c.dial(ctx)
	if err != nil {
		return err
	}
	_ = conn.Close()
	return nil
}

// PopUsage drains up to BatchSize messages from the configured queue.
// Returns an empty slice (no error) when the queue is empty.
func (c *RedisQueue) PopUsage(ctx context.Context) ([]string, error) {
	if c == nil {
		return nil, fmt.Errorf("redis queue client is nil")
	}
	if c.queueKey == "" {
		return nil, fmt.Errorf("redis queue key is required")
	}
	if c.batchSize <= 0 {
		return nil, fmt.Errorf("redis queue batch size must be positive")
	}
	conn, reader, err := c.dial(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if err := writeRESPCommand(conn, RedisLPopCommand, c.queueKey, strconv.Itoa(c.batchSize)); err != nil {
		return nil, fmt.Errorf("write LPOP: %w", err)
	}
	v, err := readRESPValue(reader)
	if err != nil {
		return nil, fmt.Errorf("read LPOP response: %w", err)
	}
	if v.err != "" {
		return nil, fmt.Errorf("redis LPOP failed: %s", v.err)
	}
	return v.strings(), nil
}

// SubscribeUsage establishes a Redis-style Pub/Sub subscription to the usage
// channel. CPA broadcasts new records to every subscriber and stops appending
// them to the LPOP queue while subscribers are present, so persistent consumers
// should prefer this stream and use LPOP only to clear pre-subscription backlog.
func (c *RedisQueue) SubscribeUsage(ctx context.Context) (<-chan string, <-chan error, error) {
	if c == nil {
		return nil, nil, fmt.Errorf("redis queue client is nil")
	}
	conn, reader, err := c.dial(ctx)
	if err != nil {
		return nil, nil, err
	}
	fail := func(err error) (<-chan string, <-chan error, error) {
		_ = conn.Close()
		return nil, nil, err
	}
	if err := writeRESPCommand(conn, RedisSubscribeCommand, c.queueKey); err != nil {
		return fail(fmt.Errorf("write SUBSCRIBE: %w", err))
	}
	ack, err := readRESPValue(reader)
	if err != nil {
		return fail(fmt.Errorf("read SUBSCRIBE response: %w", err))
	}
	if ack.err != "" {
		return fail(fmt.Errorf("%w: %s", ErrRedisSubscribeUnsupported, ack.err))
	}
	if !isSubscribeAck(ack, c.queueKey) {
		return fail(fmt.Errorf("%w: unexpected subscribe response", ErrRedisSubscribeUnsupported))
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return fail(fmt.Errorf("clear redis subscription deadline: %w", err))
	}

	buffer := c.batchSize * 2
	if buffer < 1024 {
		buffer = 1024
	}
	messages := make(chan string, buffer)
	errs := make(chan error, 1)
	go c.readUsageSubscription(ctx, conn, reader, messages, errs)
	return messages, errs, nil
}

func (c *RedisQueue) readUsageSubscription(ctx context.Context, conn net.Conn, reader *bufio.Reader, messages chan<- string, errs chan<- error) {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()
	defer close(done)
	defer close(messages)
	defer close(errs)
	defer conn.Close()

	for {
		value, err := readRESPValue(reader)
		if err != nil {
			if ctx.Err() == nil {
				errs <- fmt.Errorf("read usage subscription: %w", err)
			}
			return
		}
		if value.err != "" {
			errs <- fmt.Errorf("usage subscription failed: %s", value.err)
			return
		}
		payload, ok := pubSubMessage(value, c.queueKey)
		if !ok || isUsageControlPayload(payload) {
			continue
		}
		select {
		case messages <- payload:
		case <-ctx.Done():
			return
		}
	}
}

func isSubscribeAck(value respValue, channel string) bool {
	if len(value.array) != 3 {
		return false
	}
	return respString(value.array[0]) == "subscribe" && respString(value.array[1]) == channel
}

func pubSubMessage(value respValue, channel string) (string, bool) {
	if len(value.array) != 3 || respString(value.array[0]) != "message" || respString(value.array[1]) != channel {
		return "", false
	}
	if value.array[2].bulk == nil {
		return "", false
	}
	return *value.array[2].bulk, true
}

func respString(value respValue) string {
	if value.bulk != nil {
		return *value.bulk
	}
	return value.simple
}

func isUsageControlPayload(payload string) bool {
	payload = strings.TrimSpace(payload)
	return payload == `{"support_refresh":true}` || payload == `{"refresh":true}`
}

func (c *RedisQueue) dial(ctx context.Context) (net.Conn, *bufio.Reader, error) {
	if c.address == "" {
		return nil, nil, fmt.Errorf("redis queue address is required")
	}
	if c.managementKey == "" {
		return nil, nil, fmt.Errorf("redis queue management key is required")
	}
	dialer := net.Dialer{Timeout: c.timeout}
	conn, err := dialer.DialContext(ctx, redisNetwork, c.address)
	if err != nil {
		return nil, nil, fmt.Errorf("dial redis: %w", err)
	}
	if c.timeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(c.timeout))
	}
	reader := bufio.NewReader(conn)
	if err := writeRESPCommand(conn, RedisAuthCommand, c.managementKey); err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("write AUTH: %w", err)
	}
	authResp, err := readRESPValue(reader)
	if err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("read AUTH response: %w", err)
	}
	if authResp.err != "" {
		conn.Close()
		return nil, nil, fmt.Errorf("%w: %s", ErrRedisAuth, authResp.err)
	}
	return conn, reader, nil
}

func resolveRedisAddress(baseURL, override string) string {
	override = strings.TrimSpace(override)
	if override != "" {
		if parsed, err := url.Parse(override); err == nil && parsed.Host != "" {
			return parsed.Host
		}
		return override
	}
	trimmed := strings.TrimSpace(baseURL)
	if trimmed == "" {
		return ""
	}
	if parsed, err := url.Parse(trimmed); err == nil && parsed.Host != "" {
		if parsed.Port() != "" {
			return parsed.Host
		}
		return net.JoinHostPort(parsed.Hostname(), RedisDefaultPort)
	}
	trimmed = strings.TrimPrefix(strings.TrimPrefix(trimmed, "http://"), "https://")
	if _, _, err := net.SplitHostPort(trimmed); err == nil {
		return trimmed
	}
	return net.JoinHostPort(trimmed, RedisDefaultPort)
}

// --- minimal RESP reader/writer ---

func writeRESPCommand(w io.Writer, parts ...string) error {
	if _, err := fmt.Fprintf(w, "*%d\r\n", len(parts)); err != nil {
		return err
	}
	for _, part := range parts {
		if _, err := fmt.Fprintf(w, "$%d\r\n%s\r\n", len(part), part); err != nil {
			return err
		}
	}
	return nil
}

type respValue struct {
	simple string
	bulk   *string
	array  []respValue
	err    string
	nilv   bool
}

func (v respValue) strings() []string {
	if v.nilv {
		return nil
	}
	if v.bulk != nil {
		return []string{*v.bulk}
	}
	if len(v.array) == 0 {
		return nil
	}
	out := make([]string, 0, len(v.array))
	for _, item := range v.array {
		if item.bulk != nil {
			out = append(out, *item.bulk)
		}
	}
	return out
}

func readRESPValue(r *bufio.Reader) (respValue, error) {
	prefix, err := r.ReadByte()
	if err != nil {
		return respValue{}, err
	}
	switch prefix {
	case '+':
		line, err := readRESPLine(r)
		return respValue{simple: line}, err
	case '-':
		line, err := readRESPLine(r)
		return respValue{err: line}, err
	case '$':
		return readRESPBulk(r)
	case '*':
		return readRESPArray(r)
	case ':':
		line, err := readRESPLine(r)
		return respValue{simple: line}, err
	default:
		return respValue{}, fmt.Errorf("unexpected RESP prefix %q", prefix)
	}
}

func readRESPBulk(r *bufio.Reader) (respValue, error) {
	line, err := readRESPLine(r)
	if err != nil {
		return respValue{}, err
	}
	size, err := strconv.Atoi(line)
	if err != nil {
		return respValue{}, fmt.Errorf("parse bulk size: %w", err)
	}
	if size < 0 {
		return respValue{nilv: true}, nil
	}
	buf := make([]byte, size+2)
	if _, err := io.ReadFull(r, buf); err != nil {
		return respValue{}, err
	}
	value := string(buf[:size])
	return respValue{bulk: &value}, nil
}

func readRESPArray(r *bufio.Reader) (respValue, error) {
	line, err := readRESPLine(r)
	if err != nil {
		return respValue{}, err
	}
	count, err := strconv.Atoi(line)
	if err != nil {
		return respValue{}, fmt.Errorf("parse array size: %w", err)
	}
	if count < 0 {
		return respValue{nilv: true}, nil
	}
	items := make([]respValue, 0, count)
	for i := 0; i < count; i++ {
		item, err := readRESPValue(r)
		if err != nil {
			return respValue{}, err
		}
		items = append(items, item)
	}
	return respValue{array: items}, nil
}

func readRESPLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"), nil
}
