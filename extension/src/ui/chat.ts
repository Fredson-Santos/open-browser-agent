// Tela do chat e lista de conversas.

import * as conversations from "../agent/conversations";
import { Agent } from "../agent/loop";
import { CHAT_SESSION, type ChatItem, K, type SessionView } from "../store";
import { toHtml } from "./markdown";
import * as nav from "./nav";
import "./modelmenu"; // seletor de modelo do chip (registra os próprios eventos)
import * as settings from "./settings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const SUGGESTIONS: { text: string; send: boolean }[] = [
  { text: "Resuma esta página em tópicos", send: true },
  { text: "Quais são os principais links e botões desta página?", send: true },
  { text: "Preencha o formulário desta página com dados de teste", send: true },
  { text: "Pesquise nesta página por ", send: false },
];

const messages = $("messages");
const prompt = $<HTMLTextAreaElement>("prompt");
const sendBtn = $<HTMLButtonElement>("send");
const agent = new Agent(render);
/** Blocos de ações que o usuário expandiu (índice do primeiro item). */
let openGroups = new Set<number>();
let shownConv = "";

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconButton(name: string, label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = el("button", "icon");
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(name));
  b.addEventListener("click", () => onClick(b));
  return b;
}

// ---------------------------------------------------------------- mensagens

function renderWelcome(): HTMLElement {
  const box = el("div", "welcome");
  const logo = el("div", "logo");
  logo.append(icon("chat"));
  box.append(logo);
  const ready = settings.isConfigured(settings.current());
  box.append(el("h2", "", ready ? "Como posso ajudar nesta página?" : "Configure um provedor de IA"));
  box.append(
    el(
      "p",
      "",
      ready
        ? "Eu leio a aba aberta agora e posso clicar, digitar, navegar e preencher formulários. Você vê cada passo e pode parar a qualquer momento."
        : "Cole a API key de qualquer provedor compatível com OpenAI. A NVIDIA tem uma key grátis em build.nvidia.com.",
    ),
  );
  const list = el("div", "suggestions");
  if (ready) {
    for (const s of SUGGESTIONS) {
      const b = el("button", "", s.text.trim() + (s.send ? "" : "…"));
      b.type = "button";
      b.addEventListener("click", () => {
        prompt.value = s.text;
        autosize();
        if (s.send) void submit();
        else prompt.focus();
      });
      list.append(b);
    }
  } else {
    const b = el("button", "primary", "Abrir configurações");
    b.type = "button";
    b.style.textAlign = "center";
    b.addEventListener("click", () => nav.show("settings"));
    list.append(b);
  }
  box.append(list);
  return box;
}

function renderAssistant(text: string): HTMLElement {
  const box = el("div", "msg-assistant");
  const body = el("div");
  body.innerHTML = toHtml(text); // toHtml escapa todo o texto; só gera tags fixas
  box.append(...body.childNodes);
  const actions = el("div", "msg-actions");
  actions.append(
    iconButton("copy", "Copiar", async (b) => {
      await navigator.clipboard.writeText(text).catch(() => {});
      b.replaceChildren(icon("check"));
      setTimeout(() => b.replaceChildren(icon("copy")), 1500);
    }),
  );
  box.append(actions);
  return box;
}

function renderError(text: string, isLast: boolean): HTMLElement {
  const box = el("div", "msg-error");
  const body = el("div", "text");
  body.append(el("b", "", "Algo deu errado"), text);
  if (isLast && !agent.running) {
    const row = el("div", "row");
    const retry = el("button", "small", "Tentar de novo");
    retry.type = "button";
    retry.addEventListener("click", () => void retryLast());
    row.append(retry);
    if (/HTTP (401|403|404)|Configure|key/i.test(text)) {
      const cfg = el("button", "small ghost", "Configurações");
      cfg.type = "button";
      cfg.addEventListener("click", () => nav.show("settings"));
      row.append(cfg);
    }
    body.append(row);
  }
  box.append(body);
  return box;
}

function renderActivity(steps: ToolItem[], start: number): HTMLElement {
  const box = el("details", "activity");
  box.open = openGroups.has(start);
  box.addEventListener("toggle", () => {
    if (box.open) openGroups.add(start);
    else openGroups.delete(start);
  });
  const pending = steps.find((s) => s.ok === undefined);
  const failed = steps.filter((s) => s.ok === false).length;
  const summary = el("summary");
  summary.append(pending ? el("span", "spinner") : icon("chevron"));
  if (!pending) summary.lastElementChild!.classList.add("chev");
  const label = pending
    ? `${pending.detail}…`
    : `${steps.length} ${steps.length === 1 ? "ação" : "ações"}${failed ? ` · ${failed} com erro` : ""}`;
  summary.append(el("span", "label", label));
  if (pending) summary.append(icon("chevron"));
  if (pending) summary.lastElementChild!.classList.add("chev");
  box.append(summary);

  const ol = el("ol");
  for (const s of steps) {
    const li = el("li");
    li.append(el("span", `dot ${s.ok === undefined ? "warn" : s.ok ? "ok" : "err"}`));
    const what = el("div", "what", s.detail);
    if (s.detail !== s.tool) what.append(" ", el("small", "", s.tool));
    if (s.error) what.append(el("span", "err", s.error));
    li.append(what);
    ol.append(li);
  }
  box.append(ol);
  return box;
}

function render(): void {
  if (shownConv !== agent.conv.id) {
    shownConv = agent.conv.id;
    openGroups = new Set();
  }
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  const items = agent.items;
  messages.replaceChildren();

  if (items.length === 0) {
    messages.append(renderWelcome());
  } else {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "tool") {
        const start = i;
        const steps: ToolItem[] = [];
        while (i < items.length && items[i].kind === "tool") steps.push(items[i++] as ToolItem);
        i--;
        messages.append(renderActivity(steps, start));
      } else if (item.kind === "user") {
        messages.append(el("div", "msg-user", item.text));
      } else if (item.kind === "assistant") {
        messages.append(renderAssistant(item.text));
      } else if (item.kind === "error") {
        messages.append(renderError(item.text, i === items.length - 1));
      } else {
        messages.append(el("div", "msg-note", item.text));
      }
    }
    const last = items.at(-1);
    if (agent.running && last?.kind !== "tool") {
      const typing = el("div", "typing");
      typing.append(el("span"), el("span"), el("span"));
      messages.append(typing);
    }
  }
  if (nearBottom || agent.running) messages.scrollTop = messages.scrollHeight;

  $("chat-title").textContent = agent.conv.title || "Nova conversa";
  sendBtn.replaceChildren(icon(agent.running ? "stop" : "send"));
  sendBtn.classList.toggle("stop", agent.running);
  sendBtn.setAttribute("aria-label", agent.running ? "Parar" : "Enviar");
  sendBtn.title = agent.running ? "Parar" : "Enviar";
  updateSendState();
  for (const id of ["new-chat", "clear-chat", "open-history"]) $<HTMLButtonElement>(id).disabled = agent.running;
  $<HTMLButtonElement>("clear-chat").disabled ||= items.length === 0;
}

function updateSendState(): void {
  sendBtn.disabled = !agent.running && !prompt.value.trim();
}

function renderModelChip(): void {
  const cfg = settings.current();
  const chip = $("model-chip");
  chip.textContent = cfg.model ? cfg.model.split("/").at(-1)! : "Escolher modelo";
  chip.title = cfg.model ? `${cfg.model} · ${cfg.baseUrl}` : "Configurar modelo";
}

// ---------------------------------------------------------------- envio

async function windowId(): Promise<number> {
  return (await chrome.windows.getCurrent()).id!;
}

async function submit(): Promise<void> {
  if (agent.running) {
    agent.stop();
    return;
  }
  const text = prompt.value.trim();
  if (!text) return;
  if (!settings.isConfigured(settings.current())) {
    nav.show("settings");
    return;
  }
  prompt.value = "";
  autosize();
  await agent.run(text, settings.current(), await windowId());
}

async function retryLast(): Promise<void> {
  await agent.retry(settings.current(), await windowId());
}

function autosize(): void {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
  updateSendState();
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  void submit();
});
prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
});
prompt.addEventListener("input", autosize);

$("new-chat").addEventListener("click", async () => {
  await agent.newConversation();
  prompt.focus();
});
$("clear-chat").addEventListener("click", async () => {
  await agent.clear();
  prompt.focus();
});
$("open-history").addEventListener("click", () => nav.show("history"));
$("open-settings").addEventListener("click", () => nav.show("settings"));
$("open-control").addEventListener("click", () => nav.show("control"));

// Aba em que o agente vai agir (a ativa nesta janela).
async function renderTab(): Promise<void> {
  const win = await chrome.windows.getCurrent().catch(() => undefined);
  const [tab] = win ? await chrome.tabs.query({ active: true, windowId: win.id }) : [];
  const label = $("chat-tab");
  label.textContent = tab ? tab.title || tab.url || "" : "";
  label.title = tab ? `O agente vai agir nesta aba: ${tab.url ?? ""}` : "";
}
chrome.tabs.onActivated.addListener(() => void renderTab());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title || info.status === "complete") void renderTab();
});

// Parar na pílula da página pausa a sessão do chat: interrompe o loop também.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes[K.sessions]) return;
  const s = (changes[K.sessions].newValue as Record<string, SessionView> | undefined)?.[CHAT_SESSION];
  if (s?.stopped) agent.stop();
});

// ---------------------------------------------------------------- conversas

function dayGroup(t: number): string {
  const day = 86_400_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (t >= start) return "Hoje";
  if (t >= start - day) return "Ontem";
  if (t >= start - 7 * day) return "Últimos 7 dias";
  if (t >= start - 30 * day) return "Últimos 30 dias";
  return "Mais antigas";
}

const when = (t: number) =>
  dayGroup(t) === "Hoje" || dayGroup(t) === "Ontem"
    ? new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : new Date(t).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });

async function renderHistory(): Promise<void> {
  const list = await conversations.list();
  const box = $("history-list");
  box.replaceChildren();
  $<HTMLButtonElement>("clear-all").hidden = list.length === 0;
  if (list.length === 0) {
    box.append(el("p", "msg-note", "Nenhuma conversa ainda."));
    box.lastElementChild!.setAttribute("style", "text-align:center;padding:24px 16px");
    return;
  }
  let group = "";
  for (const c of list) {
    const g = dayGroup(c.updated);
    if (g !== group) box.append(el("div", "conv-group", (group = g)));
    const row = el("div", `conv${c.id === agent.conv.id ? " active" : ""}`);
    const open = el("button", "open");
    open.type = "button";
    open.append(el("span", "", c.title), el("small", "", when(c.updated)));
    open.addEventListener("click", async () => {
      await agent.open(c.id);
      nav.show("chat");
    });
    row.append(
      open,
      iconButton("trash", "Apagar conversa", async () => {
        await conversations.remove(c.id);
        if (c.id === agent.conv.id) await agent.newConversation();
        await renderHistory();
      }),
    );
    box.append(row);
  }
}

$("history-new").addEventListener("click", async () => {
  await agent.newConversation();
  nav.show("chat");
  prompt.focus();
});

// Apagar todas pede um segundo clique em vez de um diálogo modal.
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
$("clear-all").addEventListener("click", async () => {
  const b = $<HTMLButtonElement>("clear-all");
  if (!confirmTimer) {
    b.textContent = "Confirmar exclusão";
    confirmTimer = setTimeout(() => {
      b.textContent = "Apagar todas";
      confirmTimer = undefined;
    }, 3000);
    return;
  }
  clearTimeout(confirmTimer);
  confirmTimer = undefined;
  b.textContent = "Apagar todas";
  await conversations.removeAll();
  await agent.newConversation();
  await renderHistory();
});

nav.onShow((v) => {
  if (v === "history") void renderHistory();
  if (v === "settings") settings.reset();
  if (v === "chat") {
    render();
    prompt.focus();
  }
});
settings.onChange(() => {
  renderModelChip();
  render();
});

/**
 * Porta que avisa o service worker de que este painel está aberto: quando ela
 * fecha (painel fechado), o chat para e devolve as abas. Se quem caiu foi o
 * service worker, reconecta.
 */
function keepPanelPort(): void {
  const port = chrome.runtime.connect({ name: "oba-chat" });
  port.onDisconnect.addListener(() => setTimeout(keepPanelPort, 500));
}

export async function init(): Promise<void> {
  keepPanelPort();
  await settings.init();
  renderModelChip();
  await agent.restore();
  await renderTab();
  if (!settings.isConfigured(settings.current())) nav.show("settings");
  else prompt.focus();
}
