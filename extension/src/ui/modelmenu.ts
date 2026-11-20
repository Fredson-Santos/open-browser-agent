// Seletor rápido de modelo: abre acima da caixa de mensagem ao clicar no chip
// do modelo. Lista os modelos do provedor salvo, filtra pela busca e troca o
// modelo na hora (salvo nas configurações), sem sair da conversa.

import * as nav from "./nav";
import * as settings from "./settings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const menu = $("model-menu");
const chip = $<HTMLButtonElement>("model-chip");
const search = $<HTMLInputElement>("model-search");
const list = $<HTMLUListElement>("model-options");
const refresh = $<HTMLButtonElement>("model-refresh");
const provider = $("model-provider");

let models: string[] = [];
let shown: string[] = [];
let active = -1;
let loading = false;
let error = "";

const isOpen = () => !menu.hidden;

function providerName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^(api|integrate\.api)\./, "");
  } catch {
    return url;
  }
}

/** Linha de estado (carregando, erro, vazio) dentro da lista. */
function note(text: string, kind = ""): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `note ${kind}`.trim();
  li.setAttribute("role", "presentation");
  li.textContent = text;
  return li;
}

/** Nome do modelo com o trecho buscado destacado (montado em DOM: nomes vêm do provedor). */
function label(id: string, q: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "name";
  const at = q ? id.toLowerCase().indexOf(q) : -1;
  if (at < 0) {
    span.textContent = id;
  } else {
    const mark = document.createElement("mark");
    mark.textContent = id.slice(at, at + q.length);
    span.append(id.slice(0, at), mark, id.slice(at + q.length));
  }
  return span;
}

function option(id: string, q: string, i: number, custom = false): HTMLLIElement {
  const current = settings.current().model;
  const li = document.createElement("li");
  li.id = `model-opt-${i}`;
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", "false");
  li.dataset.id = id;
  if (id === current) li.classList.add("current");
  if (custom) {
    li.classList.add("custom");
    const span = document.createElement("span");
    span.className = "name";
    span.append("Usar ", Object.assign(document.createElement("b"), { textContent: id }));
    li.append(span);
  } else {
    li.append(label(id, q));
    li.title = id;
  }
  if (id === current) {
    const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-check");
    check.append(use);
    check.classList.add("check");
    li.append(check);
  }
  li.addEventListener("mousedown", (e) => e.preventDefault()); // mantém o foco na busca
  li.addEventListener("click", () => void choose(id));
  return li;
}

function render(): void {
  const q = search.value.trim().toLowerCase();
  const current = settings.current().model;
  shown = q ? models.filter((m) => m.toLowerCase().includes(q)) : [...models];
  // O modelo atual primeiro (sem busca), para ver e manter fácil.
  if (!q && current && shown.includes(current)) shown = [current, ...shown.filter((m) => m !== current)];

  const items: HTMLLIElement[] = [];
  if (loading) items.push(note("Buscando modelos do provedor…", "loading"));
  else if (error) items.push(note(error, "err"));
  shown.forEach((id, i) => items.push(option(id, q, i)));
  // Nome digitado que não está na lista (provedores que não listam tudo).
  const typed = search.value.trim();
  if (typed && !loading && !models.some((m) => m.toLowerCase() === typed.toLowerCase())) {
    shown.push(typed);
    items.push(option(typed, q, shown.length - 1, true));
  }
  if (!loading && !error && shown.length === 0) items.push(note(models.length ? "Nenhum modelo com esse nome." : "Digite o nome do modelo."));
  list.replaceChildren(...items);

  active = -1;
  const sel = shown.indexOf(current);
  setActive(q ? 0 : sel >= 0 ? sel : 0, false);
}

function setActive(i: number, scroll = true): void {
  const options = list.querySelectorAll<HTMLLIElement>('[role="option"]');
  if (options.length === 0) {
    search.removeAttribute("aria-activedescendant");
    return;
  }
  active = (i + options.length) % options.length;
  options.forEach((o, n) => o.setAttribute("aria-selected", String(n === active)));
  search.setAttribute("aria-activedescendant", options[active].id);
  if (scroll) options[active].scrollIntoView({ block: "nearest" });
  else if (active === 0) list.scrollTop = 0;
  else options[active].scrollIntoView({ block: "nearest" });
}

async function load(force = false): Promise<void> {
  loading = true;
  error = "";
  refresh.disabled = true;
  render();
  try {
    models = await settings.availableModels(force);
    if (models.length === 0) error = "O provedor não devolveu nenhum modelo; digite o nome.";
  } catch (e) {
    error = `Não deu para listar: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    loading = false;
    refresh.disabled = false;
    if (isOpen()) render();
  }
}

async function choose(id: string): Promise<void> {
  close();
  if (id !== settings.current().model) await settings.setModel(id);
  ($("prompt") as HTMLTextAreaElement).focus();
}

export function open(): void {
  const cfg = settings.current();
  if (!cfg.baseUrl.trim() || (!cfg.apiKey.trim() && !settings.isLocal(cfg.baseUrl))) {
    nav.show("settings"); // sem provedor/key não há o que listar
    return;
  }
  menu.hidden = false;
  chip.setAttribute("aria-expanded", "true");
  provider.textContent = providerName(cfg.baseUrl);
  search.value = "";
  render();
  search.focus();
  if (models.length === 0 || error) void load(); // load usa o cache se o provedor não mudou
}

export function close(): void {
  if (!isOpen()) return;
  menu.hidden = true;
  chip.setAttribute("aria-expanded", "false");
  search.removeAttribute("aria-activedescendant");
}

chip.addEventListener("click", (e) => {
  e.stopPropagation();
  if (isOpen()) close();
  else open();
});

search.addEventListener("input", render);
search.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    setActive(active + (e.key === "ArrowDown" ? 1 : -1));
  } else if (e.key === "Enter") {
    e.preventDefault(); // não envia a mensagem
    if (active >= 0 && shown[active]) void choose(shown[active]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
    chip.focus();
  } else if (e.key === "Tab") {
    close();
  }
});

refresh.addEventListener("click", () => void load(true));
$("model-settings").addEventListener("click", () => {
  close();
  nav.show("settings");
});

document.addEventListener("mousedown", (e) => {
  if (isOpen() && !menu.contains(e.target as Node) && e.target !== chip && !chip.contains(e.target as Node)) close();
});

// Provedor ou key mudou nas configurações: a lista antiga não vale mais.
settings.onChange(() => {
  models = [];
});
