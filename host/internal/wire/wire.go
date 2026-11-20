// Package wire define as mensagens trocadas entre clientes (oba mcp) e o
// native host pelo socket local, e entre o native host e a extensão.
package wire

import "encoding/json"

// Cliente → host (JSON por linha, via TCP 127.0.0.1).
type ClientMsg struct {
	Type   string `json:"type"` // "hello" | "call" | "cancel"
	Token  string `json:"token,omitempty"`
	Client string `json:"client,omitempty"`
	// Resume (no hello) é a chave estável da sessão: o host deriva dela o id,
	// e a extensão reencontra o grupo de abas de um processo anterior.
	Resume string          `json:"resume,omitempty"`
	ID     int64           `json:"id,omitempty"`
	Tool   string          `json:"tool,omitempty"`
	Args   json.RawMessage `json:"args,omitempty"`
}

// Host → cliente.
type HostMsg struct {
	Type    string          `json:"type"` // "welcome" | "result" | "error"
	Session string          `json:"session,omitempty"`
	ID      int64           `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

// Host ↔ extensão (Native Messaging).
type ExtMsg struct {
	Type    string          `json:"type"` // "tool_request" | "tool_response" | "tool_cancel" | "session_closed" | "hello" | "host_info"
	ID      string          `json:"id,omitempty"`
	Session string          `json:"session,omitempty"`
	Client  string          `json:"client,omitempty"`
	Tool    string          `json:"tool,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
	Version string          `json:"version,omitempty"`
	Browser string          `json:"browser,omitempty"`
}
