// Package mcp implementa o servidor MCP do OBA via stdio (JSON-RPC 2.0, uma
// mensagem por linha) ou Streamable HTTP (--http), repassando as chamadas à extensão.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
	"time"

	"oba/internal/config"
)

const defaultProtocol = "2025-06-18"

var supportedProtocols = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

func isSupportedProtocol(ver string) bool {
	for _, s := range supportedProtocols {
		if ver == s {
			return true
		}
	}
	return false
}

// CallTimeout é o limite de uma chamada de ferramenta. A extensão encerra a
// chamada sozinha antes disso (CALL_DEADLINE_MS em extension/src/tools.ts, que
// já conta os pedidos de permissão), com uma mensagem melhor; este é o teto.
const CallTimeout = 240 * time.Second

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type server struct {
	out io.Writer
	mu  sync.Mutex
	hub *hubClient

	callsMu sync.Mutex
	calls   map[string]context.CancelFunc // id JSON-RPC → cancela a chamada
}

func newServer(out io.Writer, hub *hubClient) *server {
	return &server{
		out:   out,
		hub:   hub,
		calls: map[string]context.CancelFunc{},
	}
}

func (s *server) write(r response) {
	r.JSONRPC = "2.0"
	b, _ := json.Marshal(r)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.out.Write(append(b, '\n'))
}

func (s *server) cancelAll() {
	s.callsMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(s.calls))
	for k, fn := range s.calls {
		cancels = append(cancels, fn)
		delete(s.calls, k)
	}
	s.callsMu.Unlock()
	for _, fn := range cancels {
		fn()
	}
}

// Run atende o protocolo MCP em stdin/stdout até o stdin fechar.
func Run() error {
	hub := newHubClient("agente")
	hub.resume = true
	if Headless {
		if err := hub.EnsureReady(); err != nil {
			return err
		}
	}
	s := newServer(os.Stdout, hub)
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64*1024), 16<<20)
	var wg sync.WaitGroup
	for sc.Scan() {
		var req request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			s.write(response{ID: json.RawMessage("null"), Error: &rpcError{-32700, "JSON inválido"}})
			continue
		}
		if req.Method == "tools/call" {
			wg.Go(func() { s.handle(context.Background(), req) })
			continue
		}
		s.handle(context.Background(), req)
	}
	wg.Wait()
	return sc.Err()
}

func (s *server) handle(ctx context.Context, req request) {
	if resp, ok := s.dispatch(ctx, req); ok {
		s.write(*resp)
	}
}

func (s *server) dispatch(ctx context.Context, req request) (*response, bool) {
	trimmedID := bytes.TrimSpace(req.ID)
	isNotification := len(trimmedID) == 0 || string(trimmedID) == "null"

	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
			ClientInfo      struct {
				Name string `json:"name"`
			} `json:"clientInfo"`
		}
		_ = json.Unmarshal(req.Params, &p)
		if p.ClientInfo.Name != "" {
			s.hub.name = p.ClientInfo.Name
		}
		version := defaultProtocol
		if isSupportedProtocol(p.ProtocolVersion) {
			version = p.ProtocolVersion
		}
		instructions := "Controla o navegador do usuário através da extensão OBA. " +
			"Comece com tabs_context (create_if_empty=true) para obter uma aba do seu grupo."
		if Stealth {
			instructions += " Modo CyberSec/stealth ativo: use read_network, cookies, storage, http_headers, intercept_rules e http_repeater para análise e testes ofensivos."
		}
		return &response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": version,
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "oba", "version": config.Version},
				"instructions":    instructions,
			},
		}, true

	case "notifications/initialized":
		return nil, false

	case "notifications/cancelled":
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		_ = json.Unmarshal(req.Params, &p)
		s.callsMu.Lock()
		cancel := s.calls[string(p.RequestID)]
		s.callsMu.Unlock()
		if cancel != nil {
			cancel()
		}
		return nil, false

	case "ping":
		return &response{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}}, true

	case "tools/list":
		return &response{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{"tools": Tools}}, true

	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			return &response{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{-32602, "parâmetros inválidos"}}, true
		}
		if len(p.Arguments) == 0 {
			p.Arguments = json.RawMessage("{}")
		}
		cleanArgs, artexOpts := extractArtexCallOpts(p.Name, p.Arguments)

		callCtx, cancel := context.WithTimeout(ctx, CallTimeout)
		key := string(req.ID)
		s.callsMu.Lock()
		s.calls[key] = cancel
		s.callsMu.Unlock()

		res, err := s.hub.Call(callCtx, p.Name, cleanArgs)

		s.callsMu.Lock()
		delete(s.calls, key)
		s.callsMu.Unlock()
		if err == nil {
			res = processArtexIngest(callCtx, res, artexOpts)
		}
		cancel()

		if errors.Is(err, context.Canceled) {
			return nil, false // o agente cancelou: pelo MCP, não se responde a um pedido cancelado
		}
		if err != nil {
			return &response{JSONRPC: "2.0", ID: req.ID, Result: toolError(err.Error())}, true
		}
		return &response{JSONRPC: "2.0", ID: req.ID, Result: res}, true

	default:
		if !isNotification {
			return &response{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{-32601, "método não suportado: " + req.Method},
			}, true
		}
		return nil, false
	}
}

func toolError(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": msg}},
		"isError": true,
	}
}
