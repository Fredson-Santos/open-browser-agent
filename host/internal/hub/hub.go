// Package hub é o modo "native host": iniciado pelo navegador, conversa com a
// extensão via stdin/stdout e aceita clientes locais (oba mcp, scripts) num
// socket TCP em 127.0.0.1 protegido por token.
package hub

import (
	"bufio"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"oba/internal/config"
	"oba/internal/nativemsg"
	"oba/internal/wire"
)

type client struct {
	session string
	name    string
	conn    net.Conn
	mu      sync.Mutex
}

func (c *client) send(m wire.HostMsg) {
	b, _ := json.Marshal(m)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn.Write(append(b, '\n'))
}

type pending struct {
	c  *client
	id int64
}

type Hub struct {
	ext     *nativemsg.Writer
	token   string
	seq     atomic.Int64
	mu      sync.Mutex
	pending map[string]pending
	clients map[string]*client
	info    config.HostInfo
}

// Run executa o native host até a extensão fechar a conexão.
func Run(origin string) error {
	if lp, err := config.LogPath(); err == nil {
		if f, err := os.OpenFile(lp, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			log.SetOutput(f)
			defer f.Close()
		}
	}
	token, err := config.Token()
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	info := config.HostInfo{Port: port, PID: os.Getpid(), Ext: origin, Started: time.Now().UnixMilli()}
	if err := config.WriteHostInfo(info); err != nil {
		return err
	}
	defer config.RemoveHostInfo()
	log.Printf("native host iniciado (pid %d, porta %d, origem %s)", os.Getpid(), port, origin)

	h := &Hub{
		ext:     nativemsg.NewWriter(os.Stdout),
		token:   token,
		pending: map[string]pending{},
		clients: map[string]*client{},
		info:    info,
	}
	go h.accept(ln)
	h.ext.Send(wire.ExtMsg{Type: "host_info", Version: config.Version})
	err = h.readExtension(os.Stdin)
	log.Printf("extensão desconectou: %v", err)
	return nil
}

func (h *Hub) readExtension(r io.Reader) error {
	br := bufio.NewReaderSize(r, 1<<16)
	for {
		raw, err := nativemsg.Read(br)
		if err != nil {
			return err
		}
		var m wire.ExtMsg
		if err := json.Unmarshal(raw, &m); err != nil {
			log.Printf("mensagem inválida da extensão: %v", err)
			continue
		}
		switch m.Type {
		case "tool_response":
			h.mu.Lock()
			p, ok := h.pending[m.ID]
			delete(h.pending, m.ID)
			h.mu.Unlock()
			if ok {
				p.c.send(wire.HostMsg{Type: "result", ID: p.id, Result: m.Result, Error: m.Error})
			}
		case "hello":
			log.Printf("extensão conectada (versão %s, navegador %s)", m.Version, m.Browser)
			if m.Browser != "" {
				h.info.Browser = m.Browser
				config.WriteHostInfo(h.info)
			}
		}
	}
}

func (h *Hub) accept(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go h.serve(conn)
	}
}

func (h *Hub) serve(conn net.Conn) {
	defer conn.Close()
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 64*1024), 8<<20)

	if !sc.Scan() {
		return
	}
	var hello wire.ClientMsg
	if json.Unmarshal(sc.Bytes(), &hello) != nil || hello.Type != "hello" ||
		subtle.ConstantTimeCompare([]byte(hello.Token), []byte(h.token)) != 1 {
		b, _ := json.Marshal(wire.HostMsg{Type: "error", Error: "token inválido"})
		conn.Write(append(b, '\n'))
		log.Printf("conexão recusada de %s: token inválido", conn.RemoteAddr())
		return
	}
	name := strings.TrimSpace(hello.Client)
	if name == "" {
		name = "agente"
	}
	c := &client{session: fmt.Sprintf("s%d", h.seq.Add(1)), name: name, conn: conn}
	h.mu.Lock()
	h.clients[c.session] = c
	h.mu.Unlock()
	log.Printf("cliente %q conectado (sessão %s)", name, c.session)
	c.send(wire.HostMsg{Type: "welcome", Session: c.session})

	defer func() {
		h.mu.Lock()
		delete(h.clients, c.session)
		for k, p := range h.pending {
			if p.c == c {
				delete(h.pending, k)
			}
		}
		h.mu.Unlock()
		h.ext.Send(wire.ExtMsg{Type: "session_closed", Session: c.session})
		log.Printf("cliente %q desconectou (sessão %s)", name, c.session)
	}()

	for sc.Scan() {
		var m wire.ClientMsg
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		key := fmt.Sprintf("%s:%d", c.session, m.ID)
		if m.Type == "cancel" {
			// O cliente desistiu: a extensão interrompe a ação. A resposta de erro
			// que ela ainda manda segue o caminho normal e o cliente a ignora.
			h.ext.Send(wire.ExtMsg{Type: "tool_cancel", ID: key, Session: c.session})
			continue
		}
		if m.Type != "call" {
			continue
		}
		h.mu.Lock()
		h.pending[key] = pending{c: c, id: m.ID}
		h.mu.Unlock()
		err := h.ext.Send(wire.ExtMsg{
			Type: "tool_request", ID: key, Session: c.session, Client: c.name,
			Tool: m.Tool, Args: m.Args,
		})
		if err != nil {
			h.mu.Lock()
			delete(h.pending, key)
			h.mu.Unlock()
			c.send(wire.HostMsg{Type: "result", ID: m.ID, Error: err.Error()})
		}
	}
}
