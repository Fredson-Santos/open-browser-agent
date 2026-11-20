// Package mcp implementa um servidor MCP mínimo via stdio (JSON-RPC 2.0, uma
// mensagem por linha) que repassa as chamadas de ferramenta ao native host.
package mcp

import (
	"bufio"
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

func (s *server) write(r response) {
	r.JSONRPC = "2.0"
	b, _ := json.Marshal(r)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.out.Write(append(b, '\n'))
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
	s := &server{out: os.Stdout, hub: hub, calls: map[string]context.CancelFunc{}}
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
			wg.Go(func() { s.handle(req) })
			continue
		}
		s.handle(req)
	}
	wg.Wait()
	return sc.Err()
}

func (s *server) handle(req request) {
	isNotification := len(req.ID) == 0
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
			ClientInfo      struct {
				Name string `json:"name"`
			} `json:"clientInfo"`
		}
		json.Unmarshal(req.Params, &p)
		if p.ClientInfo.Name != "" {
			s.hub.name = p.ClientInfo.Name
		}
		version := p.ProtocolVersion
		if version == "" {
			version = defaultProtocol
		}
		instructions := "Controla o navegador do usuário através da extensão OBA. " +
			"Comece com tabs_context (create_if_empty=true) para obter uma aba do seu grupo."
		if Stealth {
			instructions += " Modo CyberSec/stealth ativo: use read_network, cookies, storage, http_headers, intercept_rules e http_repeater para análise e testes ofensivos."
		}
		s.write(response{ID: req.ID, Result: map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "oba", "version": config.Version},
			"instructions":    instructions,
		}})
	case "notifications/cancelled":
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		json.Unmarshal(req.Params, &p)
		s.callsMu.Lock()
		cancel := s.calls[string(p.RequestID)]
		s.callsMu.Unlock()
		if cancel != nil {
			cancel()
		}
	case "ping":
		s.write(response{ID: req.ID, Result: map[string]any{}})
	case "tools/list":
		s.write(response{ID: req.ID, Result: map[string]any{"tools": Tools}})
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			s.write(response{ID: req.ID, Error: &rpcError{-32602, "parâmetros inválidos"}})
			return
		}
		if len(p.Arguments) == 0 {
			p.Arguments = json.RawMessage("{}")
		}
		ctx, cancel := context.WithTimeout(context.Background(), CallTimeout)
		key := string(req.ID)
		s.callsMu.Lock()
		s.calls[key] = cancel
		s.callsMu.Unlock()
		res, err := s.hub.Call(ctx, p.Name, p.Arguments)
		s.callsMu.Lock()
		delete(s.calls, key)
		s.callsMu.Unlock()
		cancel()
		if errors.Is(err, context.Canceled) {
			return // o agente cancelou: pelo MCP, não se responde a um pedido cancelado
		}
		if err != nil {
			s.write(response{ID: req.ID, Result: toolError(err.Error())})
			return
		}
		s.write(response{ID: req.ID, Result: res})
	default:
		if !isNotification {
			s.write(response{ID: req.ID, Error: &rpcError{-32601, "método não suportado: " + req.Method}})
		}
	}
}

func toolError(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": msg}},
		"isError": true,
	}
}
