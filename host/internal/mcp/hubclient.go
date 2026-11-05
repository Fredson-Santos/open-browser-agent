package mcp

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"oba/internal/config"
	"oba/internal/wire"
)

var errNotConnected = errors.New(
	"o navegador não está conectado ao OBA. Abra o Brave com a extensão OBA ativa " +
		"(e rode `oba install` caso ainda não tenha rodado)")

// hubClient mantém a conexão com o native host e roteia respostas por ID.
type hubClient struct {
	name string

	mu      sync.Mutex
	conn    net.Conn
	seq     int64
	pending map[int64]chan wire.HostMsg
}

func newHubClient(name string) *hubClient {
	return &hubClient{name: name, pending: map[int64]chan wire.HostMsg{}}
}

func (h *hubClient) connect() (net.Conn, error) {
	if h.conn != nil {
		return h.conn, nil
	}
	info, err := config.ReadHostInfo()
	if err != nil {
		return nil, errNotConnected
	}
	token, err := config.Token()
	if err != nil {
		return nil, err
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", info.Port), 3*time.Second)
	if err != nil {
		return nil, errNotConnected
	}
	b, _ := json.Marshal(wire.ClientMsg{Type: "hello", Token: token, Client: h.name})
	conn.Write(append(b, '\n'))

	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 64*1024), 64<<20)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if !sc.Scan() {
		conn.Close()
		return nil, errNotConnected
	}
	conn.SetReadDeadline(time.Time{})
	var w wire.HostMsg
	if json.Unmarshal(sc.Bytes(), &w) != nil || w.Type != "welcome" {
		conn.Close()
		return nil, fmt.Errorf("native host recusou a conexão: %s", w.Error)
	}
	h.conn = conn
	go h.readLoop(conn, sc)
	return conn, nil
}

func (h *hubClient) readLoop(conn net.Conn, sc *bufio.Scanner) {
	for sc.Scan() {
		var m wire.HostMsg
		if json.Unmarshal(sc.Bytes(), &m) != nil || m.Type != "result" {
			continue
		}
		h.mu.Lock()
		ch := h.pending[m.ID]
		delete(h.pending, m.ID)
		h.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
	// Conexão caiu: falha as chamadas pendentes e força reconexão na próxima.
	h.mu.Lock()
	if h.conn == conn {
		h.conn = nil
	}
	for id, ch := range h.pending {
		ch <- wire.HostMsg{Type: "result", ID: id, Error: "conexão com o navegador perdida"}
		delete(h.pending, id)
	}
	h.mu.Unlock()
	conn.Close()
}

// Probe verifica se o native host aceita uma conexão autenticada.
func Probe() error {
	h := newHubClient("oba status")
	conn, err := h.connect()
	if err != nil {
		return err
	}
	return conn.Close()
}

// Call executa uma ferramenta na extensão e devolve o resultado MCP bruto.
func (h *hubClient) Call(tool string, args json.RawMessage, timeout time.Duration) (json.RawMessage, error) {
	h.mu.Lock()
	conn, err := h.connect()
	if err != nil {
		h.mu.Unlock()
		return nil, err
	}
	h.seq++
	id := h.seq
	ch := make(chan wire.HostMsg, 1)
	h.pending[id] = ch
	h.mu.Unlock()

	b, _ := json.Marshal(wire.ClientMsg{Type: "call", ID: id, Tool: tool, Args: args})
	if _, err := conn.Write(append(b, '\n')); err != nil {
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		return nil, errNotConnected
	}

	select {
	case m := <-ch:
		if m.Error != "" {
			return nil, errors.New(m.Error)
		}
		return m.Result, nil
	case <-time.After(timeout):
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		return nil, fmt.Errorf("tempo esgotado após %s esperando o navegador", timeout)
	}
}
