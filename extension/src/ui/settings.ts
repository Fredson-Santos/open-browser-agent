// Tela de configurações do chat: provedor, key, modelo e opções.

import { listModels } from "../agent/llm";
import { type ChatConfig, DEFAULT_CHAT_CONFIG, K, getLocal } from "../store";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PRESETS: { name: string; baseUrl: string; model?: string }[] = [
  { name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.3-70b-instruct" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { name: "Personalizado", baseUrl: "" },
];

export const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url.trim());

/** Pronto para conversar: tem modelo e (key ou provedor local). */
export const isConfigured = (c: ChatConfig) => !!c.baseUrl.trim() && !!c.model.trim() && (!!c.apiKey.trim() || isLocal(c.baseUrl));

let config: ChatConfig = DEFAULT_CHAT_CONFIG;
const changed: ((c: ChatConfig) => void)[] = [];

export function current(): ChatConfig {
  return config;
}

export function onChange(fn: (c: ChatConfig) => void): void {
  changed.push(fn);
}

const base = $<HTMLInputElement>("cfg-base");
const key = $<HTMLInputElement>("cfg-key");
const model = $<HTMLInputElement>("cfg-model");
const vision = $<HTMLInputElement>("cfg-vision");
const steps = $<HTMLInputElement>("cfg-steps");
const unlimited = $<HTMLInputElement>("cfg-unlimited");

/** Com "Sem limite" ligado, o número fica desativado (mas guarda o último valor). */
function syncSteps(): void {
  steps.disabled = unlimited.checked;
  if (!unlimited.checked && !steps.value) steps.value = String(DEFAULT_CHAT_CONFIG.maxSteps);
}
unlimited.addEventListener("change", syncSteps);

function status(text: string, kind: "" | "ok" | "err" = ""): void {
  const m = $("cfg-msg");
  m.textContent = text;
  m.className = `status-line ${kind}`;
}

function markPreset(): void {
  const url = base.value.trim().replace(/\/+$/, "");
  const match = PRESETS.find((p) => p.baseUrl && p.baseUrl === url) ?? PRESETS.at(-1)!;
  for (const b of $("presets").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.textContent === match.name));
}

function fill(): void {
  base.value = config.baseUrl;
  key.value = config.apiKey;
  model.value = config.model;
  vision.checked = config.vision;
  unlimited.checked = config.maxSteps === 0;
  steps.value = config.maxSteps === 0 ? String(DEFAULT_CHAT_CONFIG.maxSteps) : String(config.maxSteps);
  syncSteps();
  markPreset();
}

function read(): ChatConfig {
  const n = Number.parseInt(steps.value, 10);
  return {
    baseUrl: base.value.trim().replace(/\/+$/, ""),
    apiKey: key.value.trim(),
    model: model.value.trim(),
    vision: vision.checked,
    maxSteps: unlimited.checked ? 0 : Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : DEFAULT_CHAT_CONFIG.maxSteps,
  };
}

for (const p of PRESETS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = p.name;
  b.setAttribute("role", "radio");
  b.addEventListener("click", () => {
    if (p.baseUrl) {
      base.value = p.baseUrl;
      model.value = p.model ?? "";
    } else {
      base.focus();
    }
    markPreset();
    status(p.model || !p.baseUrl ? "" : "Escolha o modelo: \"Listar\" mostra os disponíveis.");
  });
  $("presets").append(b);
}
base.addEventListener("input", markPreset);

$("cfg-key-show").addEventListener("click", () => {
  key.type = key.type === "password" ? "text" : "password";
});

// ---------------------------------------------------------------- lista de modelos

const list = $<HTMLUListElement>("cfg-models");
const loadBtn = $<HTMLButtonElement>("cfg-load");
let models: string[] = [];
let modelsFor = ""; // base URL + key da lista carregada
let shown: string[] = [];
let active = -1;

const sourceKey = () => `${base.value.trim().replace(/\/+$/, "")}\n${key.value.trim()}`;

async function loadModels(): Promise<string[] | undefined> {
  try {
    models = await listModels(read());
    modelsFor = sourceKey();
    return models;
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), "err");
    return undefined;
  }
}

const isOpen = () => !list.hidden;

function closeList(): void {
  list.hidden = true;
  model.setAttribute("aria-expanded", "false");
  model.removeAttribute("aria-activedescendant");
  active = -1;
}

/** Nome do modelo com o trecho filtrado em negrito (montado em DOM: nomes vêm do provedor). */
function optionLabel(id: string, query: string): (Node | string)[] {
  const at = query ? id.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return [id];
  const mark = document.createElement("mark");
  mark.textContent = id.slice(at, at + query.length);
  return [id.slice(0, at), mark, id.slice(at + query.length)];
}

function setActive(i: number): void {
  const options = list.querySelectorAll<HTMLLIElement>('[role="option"]');
  if (options.length === 0) return;
  active = (i + options.length) % options.length;
  options.forEach((o, n) => o.setAttribute("aria-selected", String(n === active)));
  const el = options[active];
  model.setAttribute("aria-activedescendant", el.id);
  el.scrollIntoView({ block: "nearest" });
}

function choose(id: string): void {
  model.value = id;
  closeList();
  model.focus();
  status(`Modelo selecionado: ${id}. Salve para usar.`, "ok");
}

/** Abre a lista filtrada por `query` (vazio = todos). */
function openList(query: string): void {
  const q = query.trim().toLowerCase();
  shown = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  const current = model.value.trim();
  const count = document.createElement("li");
  count.className = "count";
  count.setAttribute("role", "presentation");
  count.textContent = q ? `${shown.length} de ${models.length} modelos` : `${models.length} modelos`;
  const items = shown.map((id, i) => {
    const li = document.createElement("li");
    li.id = `cfg-model-opt-${i}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");
    if (id === current) li.classList.add("current");
    li.append(...optionLabel(id, q));
    li.addEventListener("mousedown", (e) => e.preventDefault()); // não tira o foco do campo
    li.addEventListener("click", () => choose(id));
    return li;
  });
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.setAttribute("role", "presentation");
    empty.textContent = "Nenhum modelo com esse nome.";
    items.push(empty);
  }
  list.replaceChildren(count, ...items);
  list.hidden = false;
  model.setAttribute("aria-expanded", "true");
  active = -1;
  const sel = shown.indexOf(current);
  if (sel >= 0) setActive(sel);
  else list.scrollTop = 0;
}

loadBtn.addEventListener("click", async () => {
  if (isOpen()) return closeList();
  if (models.length === 0 || modelsFor !== sourceKey()) {
    status("Buscando modelos…");
    loadBtn.disabled = true;
    const ids = await loadModels();
    loadBtn.disabled = false;
    if (!ids) return;
    if (ids.length === 0) return status("O provedor não devolveu nenhum modelo.", "err");
  }
  status("");
  model.focus();
  openList(""); // todos; digitar filtra
});

model.addEventListener("input", () => {
  if (models.length && modelsFor === sourceKey()) openList(model.value);
});

model.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!models.length) return;
    e.preventDefault();
    if (!isOpen()) openList("");
    setActive(active < 0 ? (e.key === "ArrowDown" ? 0 : -1) : active + (e.key === "ArrowDown" ? 1 : -1));
  } else if (e.key === "Enter" && isOpen() && active >= 0) {
    e.preventDefault(); // escolhe em vez de enviar o formulário
    choose(shown[active]);
  } else if (e.key === "Escape" && isOpen()) {
    e.preventDefault();
    closeList();
  }
});

model.addEventListener("blur", () => setTimeout(() => {
  if (document.activeElement !== model && document.activeElement !== loadBtn) closeList();
}, 0));
document.addEventListener("click", (e) => {
  if (isOpen() && !(e.target as Element).closest(".picker")) closeList();
});

$("cfg-test").addEventListener("click", async () => {
  status("Testando…");
  const ids = await loadModels();
  if (!ids) return;
  const m = model.value.trim();
  if (m && ids.length && !ids.includes(m)) status(`Conectado, mas o modelo "${m}" não está na lista do provedor.`, "err");
  else status(`Conexão OK · ${ids.length} modelos disponíveis.`, "ok");
});

$("cfg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  config = read();
  await chrome.storage.local.set({ [K.chatConfig]: config });
  fill();
  status("Configurações salvas.", "ok");
  for (const fn of changed) fn(config);
});

// ---------------------------------------------------------------- troca rápida (chat)

let quick = { source: "", ids: [] as string[] };

/** Modelos do provedor salvo (com cache por base URL + key), para o seletor do chat. */
export async function availableModels(force = false): Promise<string[]> {
  const source = `${config.baseUrl.trim().replace(/\/+$/, "")}\n${config.apiKey.trim()}`;
  if (force || quick.source !== source || quick.ids.length === 0) {
    quick = { source, ids: await listModels(config) };
  }
  return quick.ids;
}

/** Troca só o modelo e salva, sem passar pela tela de configurações. */
export async function setModel(id: string): Promise<void> {
  config = { ...config, model: id.trim() };
  await chrome.storage.local.set({ [K.chatConfig]: config });
  fill();
  for (const fn of changed) fn(config);
}

export async function init(): Promise<void> {
  config = { ...DEFAULT_CHAT_CONFIG, ...(await getLocal<Partial<ChatConfig>>(K.chatConfig, {})) };
  fill();
}

/** Ao abrir a tela, mostra o que está salvo (descarta edições não salvas). */
export function reset(): void {
  closeList();
  fill();
  status("");
}
