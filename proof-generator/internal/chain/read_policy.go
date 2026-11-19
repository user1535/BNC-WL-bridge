package chain

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/rpc"
)

// Only idempotent reads use this policy. Authentication/decoding errors never retry.
func retryRead[T any](ctx context.Context, read func() (T, error)) (T, error) {
	var value T
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if ctx.Err() != nil {
			return value, ctx.Err()
		}
		value, err = read()
		if err == nil || !transientReadError(err) || attempt == 2 {
			return value, err
		}
		timer := time.NewTimer(time.Duration(100*(1<<attempt)) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return value, ctx.Err()
		case <-timer.C:
		}
	}
	return value, err
}

func transientReadError(err error) bool {
	var httpError rpc.HTTPError
	if errors.As(err, &httpError) {
		return httpError.StatusCode == 429 || httpError.StatusCode == 502 || httpError.StatusCode == 503 || httpError.StatusCode == 504
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return true
	}
	var rpcError rpc.Error
	return errors.As(err, &rpcError) && rpcError.ErrorCode() == -32005 && !logRangeError(err)
}

func logRangeError(err error) bool {
	var rpcError rpc.Error
	if !errors.As(err, &rpcError) {
		return false
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{"block range", "range too", "too many results", "query returned more", "response size exceeded"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}
