// Leo Outreach — self-hosted email verification service.
//
// A small, isolated HTTP wrapper around github.com/AfterShip/email-verifier
// (MIT). It exists because Leo Outreach is TypeScript/Node while AfterShip's
// verifier is Go: rather than porting the engine (unsafe), the engine runs
// here as a sidecar and the app talks to it over loopback JSON.
//
// Design rules:
//   - Loopback by default (127.0.0.1). Never expose this publicly.
//   - Optional shared bearer token (EMAIL_VERIFICATION_SERVICE_TOKEN).
//   - Only ever operates on email addresses — no URL fetching, no SSRF surface.
//   - Global in-flight cap so callers cannot hammer remote mail servers.
//   - Per-request timeout bounded by EMAIL_VERIFICATION_TIMEOUT_MS.
//   - The response is a NEUTRAL facts+error payload; status mapping
//     (VALID/INVALID/CATCH_ALL/RISKY/UNKNOWN) lives in the Node adapter
//     (src/lib/verification/aftership-adapter.ts), single-sourced there.
//
// Endpoints:
//   GET  /healthz        → { ok, engine, smtpEnabled }
//   POST /v1/verify      → { email, reachable, syntax, has_mx_records,
//                            disposable, role_account, free, suggestion,
//                            smtp, error }
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	emailverifier "github.com/AfterShip/email-verifier"
)

// ---------------------------------------------------------------------------
// Configuration (environment)
// ---------------------------------------------------------------------------

type config struct {
	listen       string
	token        string
	smtpEnabled  bool
	fromEmail    string
	helloName    string
	timeout      time.Duration
	maxInflight  int
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envInt(key string, def, min, max int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return def
	}
	return n
}

func loadConfig() config {
	timeoutMs := envInt("EMAIL_VERIFICATION_TIMEOUT_MS", 15000, 1000, 120000)
	return config{
		listen:      envStr("EMAIL_VERIFICATION_LISTEN", "127.0.0.1:8099"),
		token:       os.Getenv("EMAIL_VERIFICATION_SERVICE_TOKEN"),
		smtpEnabled: envBool("EMAIL_VERIFICATION_SMTP_ENABLED", true),
		fromEmail:   envStr("EMAIL_VERIFICATION_FROM_EMAIL", "user@example.org"),
		helloName:   envStr("EMAIL_VERIFICATION_HELLO_NAME", "localhost"),
		timeout:     time.Duration(timeoutMs) * time.Millisecond,
		maxInflight: envInt("EMAIL_VERIFICATION_MAX_INFLIGHT", 4, 1, 64),
	}
}

// ---------------------------------------------------------------------------
// Wire payload (mirrors AfterShip Result + a classified error)
// ---------------------------------------------------------------------------

type syntaxOut struct {
	Username string `json:"username"`
	Domain   string `json:"domain"`
	Valid    bool   `json:"valid"`
}

type smtpOut struct {
	HostExists  bool `json:"host_exists"`
	FullInbox   bool `json:"full_inbox"`
	CatchAll    bool `json:"catch_all"`
	Deliverable bool `json:"deliverable"`
	Disabled    bool `json:"disabled"`
}

type errorOut struct {
	Message string `json:"message"`
	Details string `json:"details"`
	Kind    string `json:"kind"`
}

type verifyOut struct {
	Email        string     `json:"email"`
	Reachable    string     `json:"reachable"`
	Syntax       syntaxOut  `json:"syntax"`
	HasMXRecords bool       `json:"has_mx_records"`
	Disposable   bool       `json:"disposable"`
	RoleAccount  bool       `json:"role_account"`
	Free         bool       `json:"free"`
	Suggestion   string     `json:"suggestion"`
	SMTP         *smtpOut   `json:"smtp"`
	Error        *errorOut  `json:"error"`
}

// ---------------------------------------------------------------------------
// Error classification — the only place SMTP reply semantics are read.
// Kinds must stay in sync with AfterShipErrorKind in the Node adapter.
// ---------------------------------------------------------------------------

func classifyError(err error) (kind, message, details string) {
	if err == nil {
		return "", "", ""
	}
	message = err.Error()
	details = err.Error()

	var lookup *emailverifier.LookupError
	if errors.As(err, &lookup) {
		message = lookup.Message
		details = lookup.Details
		switch lookup.Message {
		case emailverifier.ErrNoSuchHost:
			return "no_such_host", message, details
		case emailverifier.ErrTimeout:
			return "timeout", message, details
		case emailverifier.ErrBlocked:
			return "blocked", message, details
		case emailverifier.ErrTryAgainLater, emailverifier.ErrMailboxBusy,
			emailverifier.ErrExceededMessagingLimits, emailverifier.ErrTooManyRCPT:
			return "temp_failure", message, details
		case emailverifier.ErrServerUnavailable:
			// The library collapses both "server unavailable" and a definitive
			// 5xx "user unknown" into this message — the raw reply decides.
			if strings.HasPrefix(strings.TrimSpace(details), "5") && containsAny(details,
				"user unknown", "user not found", "does not exist", "may not exist",
				"no mailbox", "address rejected", "invalid address",
				"recipient rejected", "recipient invalid", "undeliverable",
			) {
				return "mailbox_rejected", message, details
			}
			return "service_unavailable", message, details
		}
	}

	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(details, "No MX records found"):
		return "no_mx", "no MX records", details
	case strings.Contains(lower, "no such host") || strings.Contains(lower, "name does not exist"):
		return "no_such_host", message, details
	case strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline exceeded") || strings.Contains(lower, "i/o timeout"):
		return "timeout", message, details
	case strings.Contains(lower, "connection refused"):
		return "connection_refused", message, details
	case strings.Contains(lower, "no route to host"), strings.Contains(lower, "network is unreachable"):
		return "connection_refused", message, details
	}

	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if dnsErr.IsNotFound {
			return "no_such_host", message, details
		}
		return "other", message, details
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout", message, details
	}
	return "other", message, details
}

func containsAny(haystack string, needles ...string) bool {
	lower := strings.ToLower(haystack)
	for _, n := range needles {
		if strings.Contains(lower, n) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

type engine struct {
	verifier *emailverifier.Verifier
	sem      chan struct{}
	timeout  time.Duration
}

func newEngine(cfg config) *engine {
	v := emailverifier.NewVerifier().
		EnableDomainSuggest()
	if cfg.smtpEnabled {
		v = v.EnableSMTPCheck()
	}
	// Bound every dial/operation so one hung mail server cannot pin a worker.
	v = v.
		ConnectTimeout(cfg.timeout).
		OperationTimeout(cfg.timeout).
		FromEmail(cfg.fromEmail).
		HelloName(cfg.helloName)
	return &engine{
		verifier: v,
		sem:      make(chan struct{}, cfg.maxInflight),
		timeout:  cfg.timeout,
	}
}

func (e *engine) verify(ctx context.Context, email string) (*verifyOut, error) {
	// Global in-flight cap: back-pressure instead of hammering MX hosts.
	select {
	case e.sem <- struct{}{}:
		defer func() { <-e.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	type result struct {
		ret *emailverifier.Result
		err error
	}
	ch := make(chan result, 1)
	go func() {
		ret, err := e.verifier.Verify(email)
		ch <- result{ret, err}
	}()

	// The library has no context API; its own connect/operation timeouts bound
	// the goroutine, and this select bounds OUR response time.
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-ch:
		return e.toWire(email, r.ret, r.err), nil
	}
}

func (e *engine) toWire(email string, ret *emailverifier.Result, err error) *verifyOut {
	out := &verifyOut{
		Email:      email,
		Reachable:  "unknown",
		Suggestion: ret.Suggestion,
		Disposable: ret.Disposable,
		RoleAccount: ret.RoleAccount,
		Free:       ret.Free,
		HasMXRecords: ret.HasMxRecords,
		Syntax: syntaxOut{
			Username: ret.Syntax.Username,
			Domain:   ret.Syntax.Domain,
			Valid:    ret.Syntax.Valid,
		},
	}
	if ret.Reachable != "" {
		out.Reachable = ret.Reachable
	}
	if ret.SMTP != nil {
		out.SMTP = &smtpOut{
			HostExists:  ret.SMTP.HostExists,
			FullInbox:   ret.SMTP.FullInbox,
			CatchAll:    ret.SMTP.CatchAll,
			Deliverable: ret.SMTP.Deliverable,
			Disabled:    ret.SMTP.Disabled,
		}
	}
	if err != nil {
		kind, message, details := classifyError(err)
		out.Error = &errorOut{Message: message, Details: details, Kind: kind}
	}
	return out
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (e *engine) authorized(r *http.Request, token string) bool {
	if token == "" {
		return true
	}
	auth := r.Header.Get("Authorization")
	return strings.HasPrefix(auth, "Bearer ") && strings.TrimPrefix(auth, "Bearer ") == token
}

func (e *engine) handleVerify(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		if !e.authorized(r, cfg.token) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		var req struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		req.Email = strings.TrimSpace(req.Email)
		if req.Email == "" || len(req.Email) > 320 || !strings.Contains(req.Email, "@") {
			// Format is decided by the engine (syntax check), but don't spend
			// a network round trip on obvious garbage.
			writeJSON(w, http.StatusOK, &verifyOut{
				Email:  req.Email,
				Syntax: syntaxOut{Valid: false},
			})
			return
		}

		// Per-request deadline = configured timeout + small grace.
		ctx, cancel := context.WithTimeout(r.Context(), cfg.timeout+2*time.Second)
		defer cancel()

		out, err := e.verify(ctx, req.Email)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "verification timed out"})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "verification failed"})
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func (e *engine) handleHealth(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          true,
			"engine":      "github.com/AfterShip/email-verifier",
			"smtpEnabled": cfg.smtpEnabled,
			"maxInflight": cfg.maxInflight,
		})
	}
}

func main() {
	cfg := loadConfig()
	eng := newEngine(cfg)

	if cfg.fromEmail == "user@example.org" && cfg.smtpEnabled {
		log.Printf("[verifier] WARNING: EMAIL_VERIFICATION_FROM_EMAIL is unset; SMTP checks use the RFC-2606 placeholder %q. Servers that validate MAIL FROM may reject the whole exchange — set EMAIL_VERIFICATION_FROM_EMAIL to an address in a domain you control (with a PTR record).", cfg.fromEmail)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", eng.handleHealth(cfg))
	mux.HandleFunc("/v1/verify", eng.handleVerify(cfg))

	srv := &http.Server{
		Addr:              cfg.listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      cfg.timeout + 10*time.Second,
		IdleTimeout:       60 * time.Second,
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Printf("[verifier] listening on http://%s (smtp=%v, timeout=%s, maxInflight=%d)",
			cfg.listen, cfg.smtpEnabled, cfg.timeout, cfg.maxInflight)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[verifier] listen failed: %v", err)
		}
	}()
	wg.Wait()
}
