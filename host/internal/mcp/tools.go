package mcp

// Tool segue o formato de tools/list do MCP.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func obj(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

var tabID = map[string]any{
	"type":        "integer",
	"description": "ID da aba (obtido com tabs_context ou tabs_create).",
}

// Tools é o catálogo exposto aos agentes. A execução acontece na extensão.
var Tools = []Tool{
	{
		Name: "tabs_context",
		Description: "Lista as abas do grupo desta sessão (cada agente tem seu próprio grupo de abas). " +
			"Chame antes de qualquer outra ferramenta para obter IDs de aba válidos. " +
			"Com create_if_empty=true, cria uma aba nova se o grupo estiver vazio.",
		InputSchema: obj(map[string]any{
			"create_if_empty": map[string]any{"type": "boolean", "description": "Cria uma aba se não houver nenhuma no grupo."},
		}),
	},
	{
		Name:        "tabs_create",
		Description: "Cria uma aba nova no grupo desta sessão, opcionalmente já abrindo uma URL.",
		InputSchema: obj(map[string]any{
			"url": map[string]any{"type": "string", "description": "URL inicial (opcional)."},
		}),
	},
	{
		Name:        "tabs_close",
		Description: "Fecha uma aba do grupo desta sessão.",
		InputSchema: obj(map[string]any{"tab_id": tabID}, "tab_id"),
	},
	{
		Name: "navigate",
		Description: "Navega a aba para uma URL e espera o carregamento. " +
			"Use \"back\", \"forward\" ou \"reload\" para controlar o histórico.",
		InputSchema: obj(map[string]any{
			"tab_id": tabID,
			"url":    map[string]any{"type": "string", "description": "URL, ou back/forward/reload."},
		}, "tab_id", "url"),
	},
	{
		Name:        "screenshot",
		Description: "Captura a área visível da aba e retorna a imagem.",
		InputSchema: obj(map[string]any{
			"tab_id": tabID,
			"format": map[string]any{"type": "string", "enum": []string{"jpeg", "png"}, "description": "Padrão: jpeg."},
		}, "tab_id"),
	},
}
