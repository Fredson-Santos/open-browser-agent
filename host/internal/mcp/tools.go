package mcp

import (
	_ "embed"
	"encoding/json"
)

// Tool segue o formato de tools/list do MCP.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// tools.json é a fonte única do catálogo: a extensão importa o mesmo arquivo
// para o chat embutido (extension/src/agent).
//
//go:embed tools.json
var toolsJSON []byte

// Tools é o catálogo exposto aos agentes. A execução acontece na extensão.
var Tools = mustTools()

func mustTools() []Tool {
	var t []Tool
	if err := json.Unmarshal(toolsJSON, &t); err != nil {
		panic("tools.json inválido: " + err.Error())
	}
	return t
}
