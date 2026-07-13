package cpa

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"testing"
	"time"
)

func TestNewRedisQueueDefaultsToUsageChannel(t *testing.T) {
	q := NewRedisQueue(RedisQueueConfig{
		BaseURL:       "http://127.0.0.1:8317",
		ManagementKey: "secret",
	})
	if q.queueKey != RedisUsageQueueKey {
		t.Fatalf("queueKey = %q, want %q", q.queueKey, RedisUsageQueueKey)
	}
	if RedisUsageQueueKey != "usage" {
		t.Fatalf("RedisUsageQueueKey = %q, want usage", RedisUsageQueueKey)
	}
}

func TestPopUsageSendsUsageChannelByDefault(t *testing.T) {
	addr, commands, stop := startRESPUsageServer(t)
	defer stop()

	q := NewRedisQueue(RedisQueueConfig{
		OverrideAddr:  addr,
		ManagementKey: "secret",
		Timeout:       time.Second,
		BatchSize:     2,
	})
	got, err := q.PopUsage(context.Background())
	if err != nil {
		t.Fatalf("PopUsage returned error: %v", err)
	}
	if want := []string{`{"id":1}`, `{"id":2}`}; !reflect.DeepEqual(got, want) {
		t.Fatalf("PopUsage = %#v, want %#v", got, want)
	}
	assertCommand(t, <-commands, []string{RedisAuthCommand, "secret"})
	assertCommand(t, <-commands, []string{RedisLPopCommand, RedisUsageQueueKey, "2"})
}

func TestSubscribeUsageSkipsControlMessagesAndStreamsRecords(t *testing.T) {
	addr, commands, stop := startRESPSubscriptionServer(t, false)
	defer stop()

	q := NewRedisQueue(RedisQueueConfig{
		OverrideAddr:  addr,
		ManagementKey: "secret",
		Timeout:       time.Second,
		BatchSize:     2,
	})
	ctx, cancel := context.WithCancel(context.Background())
	messages, errs, err := q.SubscribeUsage(ctx)
	if err != nil {
		t.Fatalf("SubscribeUsage returned error: %v", err)
	}
	assertCommand(t, <-commands, []string{RedisAuthCommand, "secret"})
	assertCommand(t, <-commands, []string{RedisSubscribeCommand, RedisUsageQueueKey})

	select {
	case got := <-messages:
		if got != `{"id":1}` {
			t.Fatalf("subscription message = %q", got)
		}
	case err := <-errs:
		t.Fatalf("subscription error before message: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for subscription message")
	}
	cancel()
}

func TestSubscribeUsageReportsUnsupportedCommand(t *testing.T) {
	addr, commands, stop := startRESPSubscriptionServer(t, true)
	defer stop()

	q := NewRedisQueue(RedisQueueConfig{
		OverrideAddr:  addr,
		ManagementKey: "secret",
		Timeout:       time.Second,
	})
	_, _, err := q.SubscribeUsage(context.Background())
	if !errors.Is(err, ErrRedisSubscribeUnsupported) {
		t.Fatalf("SubscribeUsage error = %v, want ErrRedisSubscribeUnsupported", err)
	}
	assertCommand(t, <-commands, []string{RedisAuthCommand, "secret"})
	assertCommand(t, <-commands, []string{RedisSubscribeCommand, RedisUsageQueueKey})
}

func startRESPUsageServer(t *testing.T) (addr string, commands <-chan []string, stop func()) {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	cmdCh := make(chan []string, 2)
	done := make(chan error, 1)

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		auth, err := readRESPValue(reader)
		if err != nil {
			done <- err
			return
		}
		cmdCh <- auth.strings()
		if _, err := fmt.Fprint(conn, "+OK\r\n"); err != nil {
			done <- err
			return
		}

		pop, err := readRESPValue(reader)
		if err != nil {
			done <- err
			return
		}
		cmdCh <- pop.strings()
		if _, err := fmt.Fprint(conn, "*2\r\n$8\r\n{\"id\":1}\r\n$8\r\n{\"id\":2}\r\n"); err != nil {
			done <- err
			return
		}
		done <- nil
	}()

	stop = func() {
		_ = ln.Close()
		select {
		case err := <-done:
			if err != nil && !isClosedNetErr(err) {
				t.Fatalf("server error: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timeout waiting for RESP test server")
		}
	}
	return ln.Addr().String(), cmdCh, stop
}

func startRESPSubscriptionServer(t *testing.T, unsupported bool) (addr string, commands <-chan []string, stop func()) {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	cmdCh := make(chan []string, 2)
	done := make(chan error, 1)

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)

		auth, err := readRESPValue(reader)
		if err != nil {
			done <- err
			return
		}
		cmdCh <- auth.strings()
		if _, err = fmt.Fprint(conn, "+OK\r\n"); err != nil {
			done <- err
			return
		}

		subscribe, err := readRESPValue(reader)
		if err != nil {
			done <- err
			return
		}
		cmdCh <- subscribe.strings()
		if unsupported {
			_, err = fmt.Fprint(conn, "-ERR unknown command 'subscribe'\r\n")
			done <- err
			return
		}
		if _, err = fmt.Fprint(conn, "*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n"); err != nil {
			done <- err
			return
		}
		if _, err = fmt.Fprint(conn, "*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$24\r\n{\"support_refresh\":true}\r\n"); err != nil {
			done <- err
			return
		}
		if _, err = fmt.Fprint(conn, "*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$8\r\n{\"id\":1}\r\n"); err != nil {
			done <- err
			return
		}
		_, err = reader.ReadByte()
		if err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, io.EOF) {
			done <- err
			return
		}
		done <- nil
	}()

	stop = func() {
		_ = ln.Close()
		select {
		case err := <-done:
			if err != nil && !isClosedNetErr(err) {
				t.Fatalf("server error: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timeout waiting for RESP subscription test server")
		}
	}
	return ln.Addr().String(), cmdCh, stop
}

func assertCommand(t *testing.T, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("command = %#v, want %#v", got, want)
	}
}

func isClosedNetErr(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, net.ErrClosed)
}
