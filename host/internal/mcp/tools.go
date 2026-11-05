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
		Name: "screenshot",
		Description: "Captura a área visível da aba. A imagem é dimensionada em pixels CSS: " +
			"as coordenadas dela podem ser usadas diretamente em computer.",
		InputSchema: obj(map[string]any{
			"tab_id": tabID,
			"format": map[string]any{"type": "string", "enum": []string{"jpeg", "png"}, "description": "Padrão: jpeg."},
		}, "tab_id"),
	},
	{
		Name: "read_page",
		Description: "Retorna a árvore de acessibilidade da página: uma linha por elemento no formato " +
			"`role \"nome\" [ref_N]`. Use os refs em computer (ref) para clicar/digitar. " +
			"filter=\"interactive\" lista só elementos clicáveis/editáveis (bem menor). " +
			"Campos de senha e cartão aparecem como [value redacted]. Refs expiram quando a página muda.",
		InputSchema: obj(map[string]any{
			"tab_id":    tabID,
			"filter":    map[string]any{"type": "string", "enum": []string{"all", "interactive"}, "description": "Padrão: all."},
			"max_depth": map[string]any{"type": "integer", "description": "Profundidade máxima (padrão 25)."},
			"ref_id":    map[string]any{"type": "string", "description": "Lê só a subárvore deste ref."},
		}, "tab_id"),
	},
	{
		Name: "find",
		Description: "Procura elementos pelo texto, rótulo, placeholder ou tipo " +
			"(ex.: \"botão entrar\", \"campo de busca\", \"link preços\"). Retorna refs ordenados por relevância. " +
			"Mais barato que read_page quando você sabe o que procura.",
		InputSchema: obj(map[string]any{
			"tab_id": tabID,
			"query":  map[string]any{"type": "string", "description": "O que procurar."},
			"limit":  map[string]any{"type": "integer", "description": "Máximo de resultados (padrão 20)."},
		}, "tab_id", "query"),
	},
	{
		Name:        "get_page_text",
		Description: "Extrai o texto legível da página (prioriza <article>/<main>). Ideal para ler artigos e documentação.",
		InputSchema: obj(map[string]any{"tab_id": tabID}, "tab_id"),
	},
	{
		Name: "computer",
		Description: "Interage com a página usando mouse e teclado nativos. Alvo: ref (de read_page/find, preferível) " +
			"ou coordinate [x, y] em pixels do screenshot.\n" +
			"Ações: left_click, right_click, middle_click, double_click, triple_click, hover, " +
			"left_click_drag (start_coordinate → coordinate), type (text; clica no alvo antes, se houver), " +
			"key (text: \"Enter\", \"ctrl+a\", \"shift+Tab\", sequências separadas por espaço como \"ctrl+a Delete\"), " +
			"scroll (scroll_direction, scroll_amount), scroll_to (ref), wait (duration em segundos), screenshot.",
		InputSchema: obj(map[string]any{
			"tab_id": tabID,
			"action": map[string]any{"type": "string", "enum": []string{
				"left_click", "right_click", "middle_click", "double_click", "triple_click", "hover",
				"left_click_drag", "type", "key", "scroll", "scroll_to", "wait", "screenshot",
			}},
			"ref":              map[string]any{"type": "string", "description": "Ref do elemento alvo (ex.: ref_12)."},
			"coordinate":       map[string]any{"type": "array", "items": map[string]any{"type": "number"}, "minItems": 2, "maxItems": 2, "description": "[x, y] em pixels do screenshot."},
			"start_coordinate": map[string]any{"type": "array", "items": map[string]any{"type": "number"}, "minItems": 2, "maxItems": 2, "description": "Início do arraste."},
			"text":             map[string]any{"type": "string", "description": "Texto para type, ou teclas para key."},
			"modifiers":        map[string]any{"type": "string", "description": "Modificadores no clique, ex.: \"ctrl\" ou \"shift+ctrl\"."},
			"repeat":           map[string]any{"type": "integer", "description": "Repetições para key (padrão 1)."},
			"scroll_direction": map[string]any{"type": "string", "enum": []string{"up", "down", "left", "right"}},
			"scroll_amount":    map[string]any{"type": "integer", "description": "Passos de scroll (padrão 3)."},
			"duration":         map[string]any{"type": "number", "description": "Segundos para wait (máx. 30)."},
		}, "tab_id", "action"),
	},
}
