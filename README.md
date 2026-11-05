# OBA — Open Browser Agent

Extensão de navegador (MV3) + host local que deixam **qualquer agente MCP**
(Claude Code, Cursor, Antigravity, Gemini CLI, Claude Desktop…) controlar o
navegador do usuário.

```
Agente MCP ──stdio──► oba mcp ──TCP 127.0.0.1 + token──► oba (native host) ──Native Messaging──► extensão
                                                          ▲ iniciado pelo navegador
```

- **`oba mcp`** — servidor MCP via stdio; é o que você configura no agente.
- **native host** — o mesmo binário, iniciado pelo navegador quando a extensão
  conecta. Abre um socket em `127.0.0.1` (porta aleatória) e só aceita clientes
  com o token de `%APPDATA%\oba\token`.
- **extensão** — executa as ferramentas: abas, navegação, screenshot via CDP.
  Cada agente conectado ganha o **próprio grupo de abas** (`OBA · <agente>`) e
  só enxerga as abas desse grupo.

## Instalação

```sh
# 1. host
cd host
go install .          # gera %USERPROFILE%\go\bin\oba.exe
oba install           # registra o native host no Brave, Chrome e Edge

# 2. extensão
cd ../extension
npm install
npm run build         # gera extension/dist
```

No Brave: `brave://extensions` → ativar **Modo de desenvolvedor** →
**Carregar sem compactação** → selecionar `extension/dist`.
O ID precisa ser `pfikhdcedpalmkfjbkldnfdiohhfomml` (fixado pela `key` do
manifest). O ícone mostra **ON** quando a extensão conectou ao host.

```sh
oba status            # confere a conexão
```

## Configurar um agente

```sh
claude mcp add oba -- "C:\Users\<você>\go\bin\oba.exe" mcp
```

Clientes com configuração JSON:

```json
{ "mcpServers": { "oba": { "command": "C:\\Users\\<você>\\go\\bin\\oba.exe", "args": ["mcp"] } } }
```

## Ferramentas (fase 1)

| Ferramenta | O que faz |
| --- | --- |
| `tabs_context` | Lista as abas do grupo da sessão (`create_if_empty` cria uma) |
| `tabs_create` | Cria aba no grupo, opcionalmente com URL |
| `tabs_close` | Fecha aba do grupo |
| `navigate` | URL, `back`, `forward` ou `reload`, esperando o carregamento |
| `screenshot` | Captura a área visível (CDP `Page.captureScreenshot`) |

## Roteiro

1. ✅ Ponte MCP ↔ host ↔ extensão, abas, navegação, screenshot
2. Árvore de acessibilidade com `ref_id`, `find`, `get_page_text`, `computer` (clique/teclado via CDP)
3. Cursor fantasma, borda de controle, botão Stop
4. Pareamento por agente, permissões por site, side panel
5. Console, network, `form_input`, upload, GIF

## Desenvolvimento

- `npm run watch` recompila a extensão; recarregue-a em `brave://extensions`.
- Log do native host: `%APPDATA%\oba\host.log`.
- Depois de mudar o host: `go install .` (o registro aponta para o binário instalado).
