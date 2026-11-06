# OBA — Open Browser Agent

Extensão de navegador (MV3) + host local que deixam **qualquer agente MCP**
(Claude Code, Cursor, Antigravity, Gemini CLI, Claude Desktop…) controlar o
navegador do usuário. Também tem um **chat embutido**: cole a API key de
qualquer provedor compatível com OpenAI (NVIDIA, OpenRouter, Groq, Ollama…) e
peça direto no side panel, sem host nem agente externo.

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

## Chat embutido

Para usar sem agente externo (e sem instalar o host): clique no ícone do OBA.
Na primeira vez abre a tela de **Configurações** (engrenagem).

| Provedor | Base URL | Observação |
| --- | --- | --- |
| NVIDIA (padrão) | `https://integrate.api.nvidia.com/v1` | Key grátis em build.nvidia.com (`nvapi-…`). Modelo padrão: `meta/llama-3.3-70b-instruct` |
| OpenRouter | `https://openrouter.ai/api/v1` | |
| Groq | `https://api.groq.com/openai/v1` | |
| OpenAI | `https://api.openai.com/v1` | |
| Ollama / LM Studio | `http://localhost:11434/v1` | Sem key |

**Listar** busca os modelos do provedor (`GET /models`). Use um modelo com
suporte a *tool calling*. **Enviar screenshots** só funciona com modelos com
visão; desligado, o agente usa `read_page`/`find`, que custam menos tokens.

Como funciona:

- O pedido vale para a **aba ativa** da janela: ela entra no grupo `OBA · Chat OBA`,
  e o site dela é liberado nesta sessão. Sites bloqueados continuam bloqueados,
  e outros sites passam pelas permissões normais.
- O loop roda no side panel (`src/agent`). Ele chama `/chat/completions`, executa
  as `tool_calls` pelas mesmas ferramentas dos agentes MCP e repete até o modelo
  responder só com texto (limite de 30 passos). **Parar** (no chat ou na página)
  interrompe; fechar o painel também.
- Ao fim de cada pedido o depurador e o overlay saem da aba (some a barra
  "está depurando"); o grupo fica enquanto a conversa estiver aberta. Trocar de
  conversa ou fechar o painel tira as abas do grupo.
- As ferramentas vêm de `host/internal/mcp/tools.json`, catálogo único usado pelo
  host Go (`go:embed`) e pela extensão.
- A key e as conversas ficam em `chrome.storage.local`, só neste navegador. O
  histórico (☰) guarda até 50 conversas, sem screenshots. A lixeira limpa a
  conversa atual, o **+** começa outra.

## Side panel

Clique no ícone da extensão. A tela principal é o chat. Na barra do topo ficam
as conversas (☰), limpar (lixeira), nova conversa (+), configurações
(engrenagem) e **Conexão e permissões** (escudo): status do host, agentes
conectados (Parar/Retomar), agentes autorizados (revogar), regras por site e o
log das últimas ações.

## Limites de tempo

Uma chamada de ferramenta tem até 210s na extensão, contando os pedidos de
permissão (cada janela espera até 75s). Passou disso, ela é interrompida e o
agente recebe um erro explicando. O `oba mcp` desiste em 240s e, se desistir
ou se o agente cancelar (`notifications/cancelled`), avisa a extensão para
interromper a ação.

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
6. ✅ Chat embutido com qualquer API compatível com OpenAI (NVIDIA, OpenRouter, Ollama…)

## Desenvolvimento

- `npm run watch` recompila a extensão; recarregue-a em `brave://extensions`.
- Log do native host: `%APPDATA%\oba\host.log`.
- Depois de mudar o host: `go install .` (o registro aponta para o binário instalado).
- Ferramentas novas: descreva em `host/internal/mcp/tools.json` (vale para MCP e chat) e implemente em `extension/src/tools.ts`.
