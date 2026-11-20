// Loop do agente do chat embutido. Roda no side panel: chama o modelo, executa
// as tool_calls pelo service worker (mesmas ferramentas e permissões dos
// agentes MCP) e repete até o modelo responder só com texto.
//
// Rodar aqui, e não no service worker, evita que o navegador encerre o worker
// no meio de uma resposta lenta do modelo. Fechar o painel interrompe o agente;
// a conversa fica salva (conversations.ts).

import catalog from "../../../host/internal/mcp/tools.json";
import type { ChatConfig, ChatItem } from "../store";
import type { ToolResult } from "../tools";
import * as conversations from "./conversations";
import { describeTool } from "./labels";
import { type Message, type Part, type ToolDef, complete } from "./llm";

/** Resultado de ferramenta maior que isso é cortado antes de ir ao modelo. */
const MAX_RESULT_CHARS = 20_000;
/** Acima disso, resultados antigos saem do histórico enviado. */
const MAX_HISTORY_CHARS = 120_000;

const SYSTEM = `Você é o agente do OBA, rodando dentro do navegador do usuário. Você controla abas do navegador com as ferramentas disponíveis.

Cada mensagem do usuário vem com a aba atual dele (tab_id, título e URL). Use esse tab_id; só abra outra aba (tabs_create) se fizer sentido para o pedido.

Como trabalhar:
- Antes de agir, entenda a página: find (busca por texto/tipo, barato), read_page com filter="interactive" (lista os elementos com refs) ou get_page_text (para ler conteúdo).
- Aja pelos refs: computer (cliques, digitação, teclas, scroll) e form_input (selects, checkboxes, campos). Refs expiram quando a página muda: depois de navegar ou de uma ação que muda a página, leia de novo.
- Depois de uma ação importante, confira se deu certo antes de seguir.
- Faça uma ferramenta por vez quando uma depender do resultado da outra.

Regras:
- Responda no idioma do usuário, de forma curta e direta. Ao terminar, diga o que fez e o resultado.
- Não invente informações da página: leia antes de afirmar.
- Peça confirmação antes de ações difíceis de desfazer (comprar, pagar, enviar mensagens ou e-mails, publicar, excluir) e não digite senhas, cartões ou dados pessoais que o usuário não tenha fornecido.
- Se uma ferramenta disser que o usuário pausou ou recusou algo, pare e explique.`;

const now = () => Date.now();

function toolDefs(cfg: ChatConfig): ToolDef[] {
  return (catalog as { name: string; description: string; inputSchema: Record<string, unknown> }[])
    // batch economiza idas e voltas de agentes MCP; no chat embutido só confunde modelos menores.
    .filter((t) => (cfg.vision || t.name !== "screenshot") && t.name !== "batch")
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

/** Troca imagens por um aviso (para salvar ou para mensagens antigas). */
function withoutImages(m: Message, note = "[screenshot antigo omitido]"): Message {
  if (m.role !== "user" || typeof m.content === "string") return m;
  const text = m.content.map((p) => (p.type === "text" ? p.text : note)).join("\n");
  return { role: "user", content: text };
}

function hasImage(m: Message): boolean {
  return m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url");
}

function size(m: Message): number {
  return typeof m.content === "string" ? m.content.length : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 1000), 0);
}

/** Histórico enviado ao modelo: só o screenshot mais recente (se a visão está ligada) e resultados antigos encolhidos. */
function prepare(history: Message[], vision: boolean): Message[] {
  const lastImage = vision ? history.findLastIndex(hasImage) : -1;
  const out = history.map((m, i) => (i === lastImage ? m : withoutImages(m)));
  let total = out.reduce((n, m) => n + size(m), 0);
  for (let i = 0; i < out.length && total > MAX_HISTORY_CHARS; i++) {
    const m = out[i];
    if (m.role === "tool" && m.content.length > 200) {
      total -= m.content.length - 40;
      out[i] = { ...m, content: "[resultado antigo omitido]" };
    }
  }
  return out;
}

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** Outra conversa: as abas da anterior saem do grupo do chat (os tab_id dela não valem mais). */
function release(): Promise<unknown> {
  return send({ type: "OBA_CHAT_RELEASE" }).catch(() => {});
}

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export class Agent {
  conv: conversations.Conversation = conversations.create();
  running = false;
  private controller?: AbortController;

  constructor(private onChange: () => void) {}

  get items(): ChatItem[] {
    return this.conv.items;
  }

  /** Reabre a última conversa usada. */
  async restore(): Promise<void> {
    const id = await conversations.activeId();
    const conv = id ? await conversations.get(id) : undefined;
    if (conv) this.conv = conv;
    this.onChange();
  }

  async open(id: string): Promise<void> {
    if (this.running) return;
    const conv = await conversations.get(id);
    if (!conv) return;
    if (conv.id !== this.conv.id) await release();
    this.conv = conv;
    await conversations.setActive(id);
    this.onChange();
  }

  /** Começa outra conversa; a atual continua no histórico. */
  async newConversation(): Promise<void> {
    if (this.running) return;
    await release();
    this.conv = conversations.create();
    await conversations.setActive(undefined);
    this.onChange();
  }

  /** Apaga a conversa atual e começa vazia. */
  async clear(): Promise<void> {
    if (this.running) return;
    await conversations.remove(this.conv.id);
    await this.newConversation();
  }

  stop(): void {
    if (!this.running) return;
    this.controller?.abort();
    void send({ type: "OBA_CHAT_ABORT" }).catch(() => {});
  }

  private push(item: ChatItem): ChatItem {
    this.conv.items.push(item);
    this.onChange();
    return item;
  }

  private save(): Promise<void> {
    return conversations.save(this.conv);
  }

  async run(text: string, cfg: ChatConfig, windowId: number): Promise<void> {
    if (this.running) return;
    this.push({ kind: "user", text, t: now() });
    if (!this.conv.title) this.conv.title = conversations.titleFrom(text);
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    this.conv.history.push({
      role: "user",
      content: `${text}\n\n[Aba atual: tab_id=${tab?.id ?? "?"} · "${tab?.title ?? ""}" · ${tab?.url ?? ""}]`,
    });
    await this.execute(cfg, windowId);
  }

  /** Tenta de novo depois de um erro (o histórico termina num pedido ou num resultado de ferramenta). */
  async retry(cfg: ChatConfig, windowId: number): Promise<void> {
    if (this.running) return;
    if (this.items.at(-1)?.kind === "error") this.conv.items.pop();
    const last = this.conv.history.at(-1);
    if (!last || last.role === "assistant") {
      this.onChange();
      return;
    }
    await this.execute(cfg, windowId);
  }

  private async execute(cfg: ChatConfig, windowId: number): Promise<void> {
    this.running = true;
    const controller = (this.controller = new AbortController());
    this.onChange();
    try {
      if (!cfg.baseUrl.trim() || !cfg.model.trim()) throw new Error("Configure o provedor e o modelo em Configurações.");

      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (!active?.id) throw new Error("Não encontrei a aba atual.");
      const begin = await send<{ ok: boolean; error?: string }>({ type: "OBA_CHAT_BEGIN", tabId: active.id });
      if (!begin.ok) throw new Error(begin.error ?? "Não consegui preparar a aba.");
      await this.save();

      const tools = toolDefs(cfg);
      for (let step = 0; ; step++) {
        if (cfg.maxSteps > 0 && step >= cfg.maxSteps) {
          this.push({ kind: "note", text: `Parei após ${cfg.maxSteps} passos. Envie "continue" para seguir.`, t: now() });
          break;
        }
        const reply = await complete(cfg, [{ role: "system", content: SYSTEM }, ...prepare(this.conv.history, cfg.vision)], tools, controller.signal);
        this.conv.history.push({ role: "assistant", content: reply.content, ...(reply.tool_calls.length ? { tool_calls: reply.tool_calls } : {}) });
        if (reply.content) this.push({ kind: "assistant", text: reply.content, t: now() });
        await this.save();
        if (reply.tool_calls.length === 0) break;

        const images: Part[] = [];
        for (const call of reply.tool_calls) {
          if (controller.signal.aborted) break;
          let args: Record<string, unknown> = {};
          let parseError = "";
          try {
            args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
          } catch {
            parseError = `argumentos inválidos (JSON): ${call.function.arguments.slice(0, 200)}`;
          }
          const item = this.push({ kind: "tool", tool: call.function.name, detail: describeTool(call.function.name, args), t: now() }) as ToolItem;

          let result: ToolResult;
          if (parseError) {
            result = { content: [{ type: "text", text: parseError }], isError: true };
          } else {
            const r = await send<{ result: ToolResult }>({ type: "OBA_CHAT_TOOL", name: call.function.name, args });
            result = r.result;
          }

          let out = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
          for (const c of result.content) {
            if (c.type !== "image") continue;
            if (cfg.vision) images.push({ type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } });
            else out += "\n(imagem não enviada: a visão está desativada nas configurações do chat)";
          }
          if (out.length > MAX_RESULT_CHARS) out = `${out.slice(0, MAX_RESULT_CHARS)}\n…[cortado: ${out.length - MAX_RESULT_CHARS} caracteres a mais; use filtros ou find]`;
          if (result.isError) out = `Erro: ${out}`;

          item.ok = !result.isError;
          if (result.isError) item.error = out.slice(0, 300);
          this.conv.history.push({ role: "tool", tool_call_id: call.id, content: out || "(sem saída)" });
          this.onChange();
        }
        if (images.length) {
          // Mensagens "tool" só aceitam texto na maioria dos provedores: a imagem vai numa mensagem do usuário.
          this.conv.history.push({ role: "user", content: [{ type: "text", text: "Screenshot resultante das ferramentas acima:" }, ...images] });
        }
        await this.save();
        if (controller.signal.aborted) break;
      }
    } catch (e) {
      if (!controller.signal.aborted) this.push({ kind: "error", text: e instanceof Error ? e.message : String(e), t: now() });
    } finally {
      if (controller.signal.aborted) this.push({ kind: "note", text: "Interrompido.", t: now() });
      this.closeDanglingCalls();
      // Solta depurador e overlay antes de liberar a próxima rodada, para o
      // fim desta não alcançar a seguinte no meio.
      await send({ type: "OBA_CHAT_END" }).catch(() => {});
      this.running = false;
      this.controller = undefined;
      await this.save();
      this.onChange();
    }
  }

  /** Toda tool_call precisa de resposta, senão o provedor recusa a próxima rodada. */
  private closeDanglingCalls(): void {
    const history = this.conv.history;
    const idx = history.findLastIndex((m) => m.role === "assistant");
    const last = history[idx];
    if (!last || last.role !== "assistant" || !last.tool_calls) return;
    const answered = new Set(history.slice(idx + 1).flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
    const missing = last.tool_calls.filter((c) => !answered.has(c.id));
    const at = idx + 1 + history.slice(idx + 1).filter((m) => m.role === "tool").length;
    history.splice(at, 0, ...missing.map((c) => ({ role: "tool" as const, tool_call_id: c.id, content: "Cancelado: o usuário interrompeu." })));
    for (const item of this.conv.items) if (item.kind === "tool" && item.ok === undefined) item.ok = false;
  }
}
