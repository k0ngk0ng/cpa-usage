package cpa

import (
	"bufio"
	"context"
	"errors"
	"fmt"
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
