package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"oba/internal/config"
	"oba/internal/headless"
	"oba/internal/wire"
)

var errNotConnected = errors.New(
	"o navegador não está conectado ao OBA. Abra o Brave com a extensão OBA ativa " +
		"(e rode `oba install` caso ainda não tenha rodado)")

// hubClient mantém a conexão com o native host e roteia respostas por ID.
type hubClient struct {
	name   string
	resume bool // envia a chave de retomada (oba mcp sim; oba status não)

	mu      sync.Mutex
	conn    net.Conn
	seq     int64
	pending map[int64]chan wire.HostMsg
}

func newHubClient(name string) *hubClient {
	return &hubClient{name: name, pending: map[int64]chan wire.HostMsg{}}
}

// Browser é a preferência de navegador (flag --browser ou OBA_BROWSER).
// Vazio = o navegador cuja extensão conectou mais recentemente.
var Browser = os.Getenv("OBA_BROWSER")

// Session é a chave de retomada (flag --session ou OBA_SESSION). Vazio = nome
// do cliente + diretório atual, que é o projeto do agente: reiniciar o agente
// no mesmo projeto volta ao mesmo grupo de abas.
var Session = os.Getenv("OBA_SESSION")

// Headless inicia ou reutiliza um navegador --headless=new gerenciado pelo OBA.
var Headless bool

// Stealth ativa auto-aprovação, ausência de overlay e coleta irrestrita na extensão.
// Exige gate explícito em main.go (--cybersec + OBA_CYBERSEC=1 + oba install --cybersec).
var Stealth bool

// ExtensionDir e Proxy configuram o launcher headless quando Headless == true.
var (
	ExtensionDir = os.Getenv("OBA_EXT_DIR")
	Proxy        = os.Getenv("OBA_PROXY")
)

func (h *hubClient) resumeKey() string {
	if Session != "" {
		return Session
	}
	dir, _ := os.Getwd()
	return h.name + "|" + strings.ToLower(dir)
}

// dialHost conecta ao native host preferido, descartando registros obsoletos.
func dialHost() (net.Conn, config.HostInfo, error) {
	if Headless {
		h, err := headless.EnsureRunning(context.Background(), headless.Options{
			Browser:          Browser,
			ExtensionDir:     ExtensionDir,
			Proxy:            Proxy,
			IgnoreCertErrors: Stealth || Proxy != "",
		})
		if err != nil {
			return nil, config.HostInfo{}, err
		}
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", h.Port), 2*time.Second)
		if err != nil {
			return nil, config.HostInfo{}, fmt.Errorf("falha ao conectar no host headless (porta %d): %w", h.Port, err)
		}
		return conn, h, nil
	}

	hosts, err := config.ListHosts()
	if err != nil {
		return nil, config.HostInfo{}, err
	}
	want := strings.ToLower(strings.TrimSpace(Browser))
	var others []string
	var ordered []config.HostInfo
	for _, h := range hosts {
		if !h.Headless {
			ordered = append(ordered, h)
		}
	}
	for _, h := range hosts {
		if h.Headless {
			ordered = append(ordered, h)
		}
	}
	for _, h := range ordered {
		if want != "" && !strings.Contains(strings.ToLower(h.Browser), want) {
			others = append(others, h.Browser)
			continue
		}
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", h.Port), 2*time.Second)
		if err != nil {
			os.Remove(h.Path) // ninguém escutando: o host morreu sem limpar
			continue
		}
		return conn, h, nil
	}
	if want != "" && len(others) > 0 {
		return nil, config.HostInfo{}, fmt.Errorf("nenhum navegador %q conectado (disponíveis: %s)", Browser, strings.Join(others, ", "))
	}
	return nil, config.HostInfo{}, errNotConnected
}

func (h *hubClient) connect() (net.Conn, error) {
	if h.conn != nil {
		return h.conn, nil
	}
	token, err := config.Token()
	if err != nil {
		return nil, err
	}
	conn, _, err := dialHost()
	if err != nil {
		return nil, err
	}
	hello := wire.ClientMsg{Type: "hello", Token: token, Client: h.name, Stealth: Stealth}
	if h.resume {
		hello.Resume = h.resumeKey()
	}
	b, _ := json.Marshal(hello)
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

// EnsureReady garante que o navegador (inclusive headless) esteja iniciado e conectado.
func (h *hubClient) EnsureReady() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := h.connect()
	return err
}

// Close encerra a conexão TCP atual com o native host, se houver.
func (h *hubClient) Close() error {
	h.mu.Lock()
	conn := h.conn
	h.conn = nil
	h.mu.Unlock()
	if conn != nil {
		return conn.Close()
	}
	return nil
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
// Se ctx terminar antes (timeout ou cancelamento do agente), pede à extensão
// que interrompa a ação, para ela não continuar sem ninguém esperando.
func (h *hubClient) Call(ctx context.Context, tool string, args json.RawMessage) (json.RawMessage, error) {
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
	case <-ctx.Done():
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		b, _ := json.Marshal(wire.ClientMsg{Type: "cancel", ID: id})
		conn.Write(append(b, '\n'))
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("tempo esgotado após %s esperando o navegador; a ação foi interrompida", CallTimeout)
		}
		return nil, ctx.Err()
	}
}
