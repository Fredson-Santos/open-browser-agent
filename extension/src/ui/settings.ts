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
  steps.value = String(config.maxSteps);
  markPreset();
}

function read(): ChatConfig {
  const n = Number.parseInt(steps.value, 10);
  return {
    baseUrl: base.value.trim().replace(/\/+$/, ""),
    apiKey: key.value.trim(),
    model: model.value.trim(),
    vision: vision.checked,
    maxSteps: Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : DEFAULT_CHAT_CONFIG.maxSteps,
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

async function loadModels(): Promise<string[] | undefined> {
  try {
    const ids = await listModels(read());
    $("cfg-models").replaceChildren(...ids.map((id) => Object.assign(document.createElement("option"), { value: id })));
    return ids;
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), "err");
    return undefined;
  }
}

$("cfg-load").addEventListener("click", async () => {
  status("Buscando modelos…");
  const ids = await loadModels();
  if (ids) {
    status(`${ids.length} modelos disponíveis. Digite no campo para filtrar.`, "ok");
    model.focus();
  }
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

export async function init(): Promise<void> {
  config = { ...DEFAULT_CHAT_CONFIG, ...(await getLocal<Partial<ChatConfig>>(K.chatConfig, {})) };
  fill();
}

/** Ao abrir a tela, mostra o que está salvo (descarta edições não salvas). */
export function reset(): void {
  fill();
  status("");
}
