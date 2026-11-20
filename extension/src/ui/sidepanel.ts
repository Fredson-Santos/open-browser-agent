// Side panel: o chat embutido é a tela principal (ui/chat.ts); a tela
// "Conexão e permissões" mostra status do host, agentes, regras por site e log.
// Lê tudo de chrome.storage e se redesenha quando algo muda.

import * as chat from "./chat";
import {
  type ClientGrant,
  DEFAULT_SETTINGS,
  type HostState,
  K,
  type LogEntry,
  type SessionView,
  type Settings,
  type SiteRule,
  getLocal,
  getSession,
} from "../store";

const $ = (id: string) => document.getElementById(id)!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function empty(text: string): HTMLElement {
  return h("p", { class: "empty" }, text);
}

const time = (t: number) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function renderStatus() {
  const s = await getSession<HostState>(K.host, { connected: false });
  $("status-dot").className = `dot ${s.connected ? "ok" : "err"}`;
  $("status-text").textContent = s.connected ? `Conectado ao host oba (${s.browser ?? "navegador"})` : "Desconectado do host oba";
  $("status-detail").textContent = s.connected
    ? "Agentes MCP podem se conectar com \"oba mcp\"."
    : s.detail
      ? `${s.detail}. Rode "oba install" e confira se o binário existe. O chat embutido funciona sem o host.`
      : "Necessário só para agentes MCP externos (rode \"oba install\"). O chat embutido funciona sem ele.";
  $("reconnect").hidden = s.connected;
}

async function renderSessions() {
  const all = await getSession<Record<string, SessionView>>(K.sessions, {});
  const box = $("sessions");
  box.replaceChildren();
  const entries = Object.entries(all);
  if (entries.length === 0) {
    box.append(empty("Nenhum agente conectado. Configure seu agente para rodar \"oba mcp\"."));
    return;
  }
  const ul = h("ul");
  for (const [id, s] of entries) {
    const tabs = s.groupId !== undefined ? await chrome.tabs.query({ groupId: s.groupId }).catch(() => []) : [];
    if (s.disconnected && tabs.length === 0) continue;
    const state = s.disconnected ? "desconectado (retoma ao reabrir o agente)" : s.denied ? "recusado" : s.stopped ? "pausado" : "ativo";
    const btn = h("button", { class: "small" + (s.stopped ? "" : " danger") }, s.stopped ? "Retomar" : "Parar");
    btn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OBA_SESSION", session: id, stop: !s.stopped }));
    ul.append(
      h(
        "li",
        {},
        h("span", { class: `dot ${s.stopped || s.denied ? "err" : s.disconnected ? "" : "ok"}` }),
        h("div", { class: "main" }, h("div", { class: "name" }, s.client), h("small", {}, `${state} · ${tabs.length} aba(s)`)),
        s.denied || s.disconnected ? null : btn,
      ),
    );
  }
  box.append(ul);
}

async function renderClients() {
  const grants = await getLocal<Record<string, ClientGrant>>(K.clients, {});
  const box = $("clients");
  box.replaceChildren();
  const names = Object.keys(grants).sort();
  if (names.length === 0) {
    box.append(empty("Nenhum agente autorizado permanentemente."));
    return;
  }
  const ul = h("ul");
  for (const name of names) {
    const revoke = h("button", { class: "link", "aria-label": `Revogar ${name}` }, "Revogar");
    revoke.addEventListener("click", async () => {
      const g = await getLocal<Record<string, ClientGrant>>(K.clients, {});
      delete g[name];
      await chrome.storage.local.set({ [K.clients]: g });
    });
    ul.append(
      h(
        "li",
        {},
        h("div", { class: "main" }, h("div", { class: "name" }, name), h("small", {}, `desde ${new Date(grants[name].approvedAt).toLocaleDateString("pt-BR")}`)),
        revoke,
      ),
    );
  }
  box.append(ul);
}

async function renderSites() {
  const settings = await getLocal<Settings>(K.settings, DEFAULT_SETTINGS);
  ($("policy") as HTMLSelectElement).value = settings.sitePolicy;
  ($("allow-js") as HTMLInputElement).checked = !!settings.allowJavascript;
  const rules = await getLocal<Record<string, SiteRule>>(K.sites, {});
  const box = $("sites");
  box.replaceChildren();
  const sites = Object.keys(rules).sort();
  if (sites.length === 0) {
    box.append(empty("Nenhuma regra ainda. Quando um agente tentar acessar um site novo, você decide."));
    return;
  }
  const ul = h("ul");
  for (const site of sites) {
    const rule = rules[site];
    const toggle = h("button", { class: "link", "aria-label": `Alternar regra de ${site}` }, rule === "allow" ? "Bloquear" : "Permitir");
    toggle.addEventListener("click", () => setRule(site, rule === "allow" ? "block" : "allow"));
    const remove = h("button", { class: "link", "aria-label": `Remover regra de ${site}` }, "Remover");
    remove.addEventListener("click", () => setRule(site, null));
    ul.append(
      h(
        "li",
        {},
        h("div", { class: "main" }, h("div", { class: "name" }, site)),
        h("span", { class: `tag ${rule}` }, rule === "allow" ? "permitido" : "bloqueado"),
        toggle,
        remove,
      ),
    );
  }
  box.append(ul);
}

async function setRule(site: string, rule: SiteRule | null) {
  const rules = await getLocal<Record<string, SiteRule>>(K.sites, {});
  if (rule) rules[site] = rule;
  else delete rules[site];
  await chrome.storage.local.set({ [K.sites]: rules });
}

async function renderLog() {
  const list = await getSession<LogEntry[]>(K.log, []);
  const box = $("log");
  box.replaceChildren();
  if (list.length === 0) {
    box.append(empty("Nenhuma ação ainda."));
    return;
  }
  const ul = h("ul", { class: "log" });
  for (const e of list.slice(0, 40)) {
    ul.append(
      h(
        "li",
        {},
        h("span", { class: `dot ${e.ok ? "ok" : "err"}`, "aria-label": e.ok ? "sucesso" : "erro" }),
        h(
          "div",
          { class: "main" },
          h("div", {}, h("b", {}, e.tool), e.detail ? " " : "", e.detail ? h("span", { class: "detail" }, e.detail) : null),
          h("small", {}, e.client),
          e.error ? h("div", { class: "err" }, e.error) : null,
        ),
        h("span", { class: "when" }, time(e.t)),
      ),
    );
  }
  box.append(ul);
}

async function updateSettings(patch: Partial<Settings>) {
  const current = await getLocal<Settings>(K.settings, DEFAULT_SETTINGS);
  await chrome.storage.local.set({ [K.settings]: { ...DEFAULT_SETTINGS, ...current, ...patch } });
}
$("policy").addEventListener("change", (e) => {
  void updateSettings({ sitePolicy: (e.target as HTMLSelectElement).value as Settings["sitePolicy"] });
});
$("allow-js").addEventListener("change", (e) => {
  void updateSettings({ allowJavascript: (e.target as HTMLInputElement).checked });
});
$("reconnect").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OBA_RECONNECT" }));

const renderers: Record<string, () => Promise<void>> = {
  [K.host]: renderStatus,
  [K.sessions]: renderSessions,
  [K.clients]: renderClients,
  [K.sites]: renderSites,
  [K.settings]: renderSites,
  [K.log]: renderLog,
};
chrome.storage.onChanged.addListener((changes) => {
  for (const key of Object.keys(changes)) void renderers[key]?.();
});
// Abas entrando/saindo dos grupos mudam a contagem.
chrome.tabs.onUpdated.addListener(() => void renderSessions());
chrome.tabs.onRemoved.addListener(() => void renderSessions());

void chat.init();
void Promise.all([renderStatus(), renderSessions(), renderClients(), renderSites(), renderLog()]);
