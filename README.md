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

## Ferramentas

| Ferramenta | O que faz |
| --- | --- |
| `tabs_context` | Lista as abas do grupo da sessão (`create_if_empty` cria uma) |
| `tabs_create` | Cria aba no grupo, opcionalmente com URL |
| `tabs_close` | Fecha aba do grupo |
| `navigate` | URL, `back`, `forward` ou `reload`, esperando o carregamento |
| `screenshot` | Captura a viewport, redimensionada para pixels CSS (= coordenadas do `computer`) |
| `read_page` | Árvore `role "nome" [ref_N]`; `filter: "interactive"`, `ref_id`, `max_depth` |
| `find` | Busca local por texto/rótulo/tipo (`"botão entrar"`), sem LLM |
| `get_page_text` | Texto legível (prioriza `<article>`/`<main>`) |
| `computer` | Cliques, hover, arraste, `type`, `key` (`"ctrl+a Delete"`), scroll, `scroll_to`, `wait`, screenshot — alvo por `ref` ou `coordinate` |
| `form_input` | Define select (pelo texto da opção), checkbox/radio, texto, data… disparando os eventos que React/Vue esperam |
| `handle_dialog` | Responde a `alert`/`confirm`/`prompt` nativos (a ação que os abre volta na hora avisando) |
| `read_console` | Console da aba: logs, warnings, erros e exceções não tratadas (filtro por regex) |
| `read_network` | Requisições com status/tipo/tamanho; `request_id` devolve o corpo da resposta |
| `file_upload` | Anexa arquivos locais a um `<input type="file">` — o usuário confirma cada envio |
| `gif_creator` | Grava as ações como GIF (com o ponto do clique e legenda) em `Downloads/oba` |
| `javascript` | Executa JS na página — **desligado por padrão**, ativado no side panel |

O motor de percepção (`src/content`) é injetado sob demanda via `chrome.scripting`:
percorre shadow DOM aberto e iframes de mesma origem, detecta elementos
clicáveis sem role (`cursor: pointer`, `onclick`, `tabindex`), ignora ocultos e
substitui valores de senha, cartão e OTP por `[value redacted]`. Os refs usam
`WeakRef` e expiram quando a página muda. Mouse e teclado usam CDP
(`Input.dispatch*`), gerando eventos com `isTrusted = true`.

## Indicadores visuais e botão Parar

Nas abas de um agente aparece uma borda ciano (pulsando enquanto uma ação
roda), um cursor que desliza até o alvo antes de cada clique e uma pílula
"<agente> está controlando esta aba · **Parar**".

- **Parar** interrompe na hora a ação em andamento, solta o depurador (a barra
  de aviso some) e faz qualquer nova chamada do agente falhar com uma mensagem
  pedindo que ele pergunte ao usuário. A borda fica vermelha e o botão vira
  **Retomar**.
- O overlay fica num Shadow DOM fechado, não intercepta cliques (só o botão
  aceita, e só cliques reais do usuário) e é escondido durante screenshots.
- Quando o agente desconecta, o overlay e o depurador são removidos.

## Permissões

- **Pareamento:** na primeira chamada de um agente novo abre uma janela
  "\<agente\> quer controlar este navegador" — *Permitir sempre*, *Só desta vez*
  ou *Recusar*. O nome vem do `clientInfo` do MCP (informado pelo próprio
  agente); a autenticação de fato é o token local.
- **Sites:** antes de ler ou agir num domínio novo, a extensão pergunta —
  *Sempre permitir neste site*, *Permitir agora* (só nesta sessão) ou
  *Bloquear site*. Fechar a janela não grava nada. No side panel dá para trocar
  a política para "permitir todos (exceto bloqueados)".

## Side panel

Clique no ícone da extensão: status da conexão, agentes conectados (com
Parar/Retomar), agentes autorizados (revogar), regras por site e o log das
últimas ações.

## Vários navegadores

Cada navegador (ou perfil) com a extensão ativa inicia o próprio host e se
registra em `%APPDATA%\oba\hosts\`. `oba status` lista todos; `oba mcp` usa o
mais recente, ou o escolhido com `oba mcp --browser brave` / `OBA_BROWSER=edge`.

## Roteiro

1. ✅ Ponte MCP ↔ host ↔ extensão, abas, navegação, screenshot
2. ✅ Árvore de acessibilidade com refs, `find`, `get_page_text`, `computer` (mouse/teclado via CDP)
3. ✅ Cursor fantasma, borda de controle, botão Parar/Retomar
4. ✅ Pareamento por agente, permissões por site, side panel, escolha de navegador
5. ✅ Console, rede, `form_input`, diálogos nativos, upload, GIF, `javascript` opcional

## Desenvolvimento

- `npm run watch` recompila a extensão; recarregue-a em `brave://extensions`.
- Log do native host: `%APPDATA%\oba\host.log`.
- Depois de mudar o host: `go install .` (o registro aponta para o binário instalado).
