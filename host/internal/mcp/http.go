package mcp

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"oba/internal/config"
	"oba/internal/headless"
)

// HTTPToken protege o servidor --http com Authorization: Bearer <token>.
var HTTPToken = os.Getenv("OBA_HTTP_TOKEN")

const httpSessionIdleTTL = 30 * time.Minute

type httpSession struct {
	id       string
	srv      *server
	lastUsed time.Time
}

type httpServer struct {
	token       string
	mu          sync.Mutex
	sessions    map[string]*httpSession
	defaultSess *httpSession
}

// NewHTTPHandler constrói o handler HTTP compatível com MCP Streamable HTTP (/mcp e /health).
func NewHTTPHandler(token string) http.Handler {
	hs := &httpServer{
		token:    strings.TrimSpace(token),
		sessions: map[string]*httpSession{},
	}
	return hs.routes()
}

func (hs *httpServer) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", hs.handleHealth)
	mux.HandleFunc("/mcp", hs.handleMCP)
	mux.HandleFunc("/", hs.handleRoot)
	return mux
}

func (hs *httpServer) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	hs.handleMCP(w, r)
}

func (hs *httpServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSONStatus(w, http.StatusOK, map[string]any{
		"ok":       true,
		"version":  config.Version,
		"tools":    len(Tools),
		"headless": Headless,
		"stealth":  Stealth,
	})
}

func (hs *httpServer) authorize(r *http.Request) bool {
	if hs.token == "" {
		return true
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if len(auth) <= len(prefix) || !strings.EqualFold(auth[:len(prefix)], prefix) {
		return false
	}
	given := strings.TrimSpace(auth[len(prefix):])
	return subtle.ConstantTimeCompare([]byte(given), []byte(hs.token)) == 1
}

func (hs *httpServer) handleMCP(w http.ResponseWriter, r *http.Request) {
	if !hs.authorize(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodOptions:
		w.Header().Set("Allow", "POST, DELETE, OPTIONS")
		w.WriteHeader(http.StatusNoContent)
	case http.MethodGet:
		w.Header().Set("Allow", "POST, DELETE")
		http.Error(w, "standalone SSE stream not offered; use POST", http.StatusMethodNotAllowed)
	case http.MethodDelete:
		hs.handleDelete(w, r)
	case http.MethodPost:
		hs.handlePost(w, r)
	default:
		w.Header().Set("Allow", "POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (hs *httpServer) handleDelete(w http.ResponseWriter, r *http.Request) {
	sid := strings.TrimSpace(r.Header.Get("Mcp-Session-Id"))
	if sid == "" {
		http.Error(w, "missing Mcp-Session-Id", http.StatusBadRequest)
		return
	}
	hs.mu.Lock()
	sess := hs.sessions[sid]
	if sess != nil {
		delete(hs.sessions, sid)
	}
	hs.mu.Unlock()
	if sess == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	sess.srv.cancelAll()
	_ = sess.srv.hub.Close()
	w.WriteHeader(http.StatusNoContent)
}

func (hs *httpServer) handlePost(w http.ResponseWriter, r *http.Request) {
	if ver := strings.TrimSpace(r.Header.Get("MCP-Protocol-Version")); ver != "" && !isSupportedProtocol(ver) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]any{
			"code":      "UNSUPPORTED_PROTOCOL_VERSION",
			"message":   "unsupported MCP-Protocol-Version: " + ver,
			"supported": supportedProtocols,
		})
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, response{
			JSONRPC: "2.0",
			ID:      json.RawMessage("null"),
			Error:   &rpcError{-32700, "erro ao ler corpo da requisição"},
		})
		return
	}

	var req request
	if err := json.Unmarshal(body, &req); err != nil || req.Method == "" {
		writeJSONStatus(w, http.StatusBadRequest, response{
			JSONRPC: "2.0",
			ID:      json.RawMessage("null"),
			Error:   &rpcError{-32700, "JSON-RPC inválido"},
		})
		return
	}

	var sess *httpSession
	sid := strings.TrimSpace(r.Header.Get("Mcp-Session-Id"))
	if req.Method == "initialize" {
		sess = hs.newSession()
		w.Header().Set("Mcp-Session-Id", sess.id)
	} else if sid != "" {
		sess = hs.getSession(sid)
		if sess == nil {
			writeJSONStatus(w, http.StatusNotFound, response{
				JSONRPC: "2.0",
				ID:      nonNullID(req.ID),
				Error:   &rpcError{-32001, "sessão MCP inválida ou expirada"},
			})
			return
		}
	} else {
		sess = hs.getDefaultSession()
	}

	resp, hasResp := sess.srv.dispatch(r.Context(), req)
	if !hasResp {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	if wantsSSEOnly(r.Header.Get("Accept")) {
		writeSSEResponse(w, *resp)
		return
	}
	writeJSONStatus(w, http.StatusOK, *resp)
}

func (hs *httpServer) newSession() *httpSession {
	hub := newHubClient("agente")
	hub.resume = true
	sid := newSessionID()
	sess := &httpSession{
		id:       sid,
		srv:      newServer(io.Discard, hub),
		lastUsed: time.Now(),
	}
	hs.mu.Lock()
	hs.sessions[sid] = sess
	hs.mu.Unlock()
	return sess
}

func (hs *httpServer) getSession(sid string) *httpSession {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	sess := hs.sessions[sid]
	if sess != nil {
		sess.lastUsed = time.Now()
	}
	return sess
}

func (hs *httpServer) getDefaultSession() *httpSession {
	hs.mu.Lock()
	defer hs.mu.Unlock()
	if hs.defaultSess == nil {
		hub := newHubClient("agente")
		hub.resume = true
		hs.defaultSess = &httpSession{
			id:       "default",
			srv:      newServer(io.Discard, hub),
			lastUsed: time.Now(),
		}
	} else {
		hs.defaultSess.lastUsed = time.Now()
	}
	return hs.defaultSess
}

func (hs *httpServer) pruneExpired(maxIdle time.Duration) {
	cutoff := time.Now().Add(-maxIdle)
	var stale []*httpSession
	hs.mu.Lock()
	for id, sess := range hs.sessions {
		if sess.lastUsed.Before(cutoff) {
			stale = append(stale, sess)
			delete(hs.sessions, id)
		}
	}
	hs.mu.Unlock()
	for _, sess := range stale {
		sess.srv.cancelAll()
		_ = sess.srv.hub.Close()
	}
}

func (hs *httpServer) closeAll() {
	hs.mu.Lock()
	var list []*httpSession
	for id, sess := range hs.sessions {
		list = append(list, sess)
		delete(hs.sessions, id)
	}
	if hs.defaultSess != nil {
		list = append(list, hs.defaultSess)
		hs.defaultSess = nil
	}
	hs.mu.Unlock()
	for _, sess := range list {
		sess.srv.cancelAll()
		_ = sess.srv.hub.Close()
	}
}

func newSessionID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err == nil {
		return hex.EncodeToString(buf[:])
	}
	return fmt.Sprintf("oba-%d", time.Now().UnixNano())
}

func nonNullID(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func wantsSSEOnly(accept string) bool {
	low := strings.ToLower(accept)
	return strings.Contains(low, "text/event-stream") &&
		!strings.Contains(low, "application/json") &&
		!strings.Contains(low, "*/*")
}

func writeJSONStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeSSEResponse(w http.ResponseWriter, resp response) {
	b, _ := json.Marshal(resp)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func isLoopbackListenAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// RunHTTP expõe o servidor MCP via transporte Streamable HTTP em addr (/mcp e /health).
func RunHTTP(addr string) error {
	if Headless {
		if _, err := headless.EnsureRunning(context.Background(), headless.Options{
			Browser:          Browser,
			ExtensionDir:     ExtensionDir,
			Proxy:            Proxy,
			IgnoreCertErrors: Stealth || Proxy != "",
		}); err != nil {
			return err
		}
	}

	if !isLoopbackListenAddr(addr) && strings.TrimSpace(HTTPToken) == "" {
		fmt.Fprintln(os.Stderr, "aviso: --http ouvindo fora de loopback sem --http-token / OBA_HTTP_TOKEN; defina um token Bearer antes de expor na rede.")
	}

	hs := &httpServer{
		token:    strings.TrimSpace(HTTPToken),
		sessions: map[string]*httpSession{},
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           hs.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("falha ao ouvir em %s: %w", addr, err)
	}

	sigCtx, stopSig := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSig()

	reaperDone := make(chan struct{})
	go func() {
		defer close(reaperDone)
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-sigCtx.Done():
				return
			case <-t.C:
				hs.pruneExpired(httpSessionIdleTTL)
			}
		}
	}()

	go func() {
		<-sigCtx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = srv.Shutdown(shutCtx)
		cancel()
	}()

	fmt.Fprintf(os.Stderr, "OBA MCP Streamable HTTP ouvindo em http://%s/mcp (health: http://%s/health)\n", ln.Addr().String(), ln.Addr().String())
	err = srv.Serve(ln)
	stopSig()
	<-reaperDone
	hs.closeAll()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
