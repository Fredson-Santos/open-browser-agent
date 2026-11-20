// Consentimento do usuário: pareamento de agentes e permissões por site.
//
// O token em %APPDATA%\oba\token já impede processos sem acesso ao seu usuário
// de se conectarem. O pareamento aqui é uma camada de consentimento: você vê
// qual agente quer controlar o navegador e quais sites ele vai acessar.
// O nome do agente é informado por ele mesmo (clientInfo do MCP).

import {
  type ClientGrant,
  type Decision,
  DEFAULT_SETTINGS,
  K,
  type Prompt,
  type Settings,
  type SiteRule,
  getLocal,
  getSession,
  siteOf,
} from "./store";
import * as sessions from "./sessions";

const PROMPT_TIMEOUT_MS = 75_000; // abaixo do timeout de 90s do oba mcp

const waiters = new Map<string, (d: Decision) => void>();
const windows = new Map<number, string>(); // windowId → prompt id
const inflight = new Map<string, Promise<Decision>>(); // dedupe por pedido

async function setPending(fn: (p: Record<string, Prompt>) => void) {
  const pending = await getSession<Record<string, Prompt>>(K.pending, {});
  fn(pending);
  await chrome.storage.session.set({ [K.pending]: pending });
}

async function ask(kind: Prompt["kind"], client: string, domain?: string, files?: string[]): Promise<Decision> {
  const key = `${kind}|${client}|${domain ?? ""}|${(files ?? []).join("|")}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const id = crypto.randomUUID();
  const promise = new Promise<Decision>((resolve) => {
    waiters.set(id, resolve);
    setTimeout(() => void decide(id, "timeout"), PROMPT_TIMEOUT_MS);
  });
  inflight.set(key, promise);
  promise.finally(() => inflight.delete(key));

  await setPending((p) => (p[id] = { id, kind, client, domain, files, created: Date.now() }));
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`approve.html?id=${id}`),
      type: "popup",
      width: 440,
      height: kind === "upload" ? 420 : 360,
      focused: true,
    });
    if (win?.id !== undefined) windows.set(win.id, id);
  } catch {
    void decide(id, "deny");
  }
  return promise;
}

/** Resposta da janela de aprovação (ou fechamento/timeout). */
export async function decide(id: string, decision: Decision): Promise<void> {
  const resolve = waiters.get(id);
  if (!resolve) return;
  waiters.delete(id);
  resolve(decision);
  await setPending((p) => delete p[id]);
  for (const [winId, pid] of windows) {
    if (pid === id) {
      windows.delete(winId);
      chrome.windows.remove(winId).catch(() => {});
    }
  }
}

chrome.windows.onRemoved.addListener((winId) => {
  const id = windows.get(winId);
  if (id) {
    windows.delete(winId);
    void decide(id, "dismissed"); // fechar a janela não grava nada
  }
});

const NO_ANSWER = "O usuário não respondeu ao pedido de permissão a tempo. Peça para ele aprovar no navegador e tente de novo.";
const DISMISSED = "O usuário fechou o pedido de permissão sem aprovar. Pergunte a ele antes de tentar de novo.";

/** Garante que o agente foi autorizado pelo usuário. */
export async function checkClient(session: string, client: string, stealth = false): Promise<void> {
  if (stealth) return;
  const s = await sessions.info(session);
  if (s?.denied) throw new Error(`O usuário recusou a conexão de "${client}" ao navegador.`);
  if (s?.approved) return;
  const grants = await getLocal<Record<string, ClientGrant>>(K.clients, {});
  if (grants[client]) return;

  const d = await ask("client", client);
  if (d === "always") {
    grants[client] = { approvedAt: Date.now() };
    await chrome.storage.local.set({ [K.clients]: grants });
  } else if (d === "session") {
    await sessions.patch(session, client, { approved: true });
  } else if (d === "timeout") {
    throw new Error(NO_ANSWER);
  } else if (d === "dismissed") {
    throw new Error(DISMISSED);
  } else {
    await sessions.patch(session, client, { denied: true });
    throw new Error(`O usuário recusou a conexão de "${client}" ao navegador.`);
  }
}

/** Garante que o agente pode acessar o site da URL. */
export async function checkSite(session: string, client: string, url: string | undefined, stealth = false): Promise<void> {
  if (stealth) return;
  const site = siteOf(url);
  if (!site) return; // about:blank, data:, páginas internas etc.
  const rules = await getLocal<Record<string, SiteRule>>(K.sites, {});
  if (rules[site] === "block") throw new Error(`O usuário bloqueou o acesso de agentes a ${site}.`);
  if (rules[site] === "allow") return;
  const settings = await getLocal<Settings>(K.settings, DEFAULT_SETTINGS);
  if (settings.sitePolicy === "allow_all") return;
  const s = await sessions.info(session);
  if (s?.sites?.includes(site)) return;

  const d = await ask("site", client, site);
  if (d === "always") {
    rules[site] = "allow";
    await chrome.storage.local.set({ [K.sites]: rules });
  } else if (d === "session") {
    await sessions.addSite(session, client, site);
  } else if (d === "timeout") {
    throw new Error(NO_ANSWER);
  } else if (d === "dismissed") {
    throw new Error(DISMISSED);
  } else {
    rules[site] = "block";
    await chrome.storage.local.set({ [K.sites]: rules });
    throw new Error(`O usuário bloqueou o acesso de agentes a ${site}.`);
  }
}

/**
 * Upload envia arquivos do computador do usuário para um site: sempre pergunta,
 * mostrando os arquivos e o destino. Não existe "permitir sempre".
 */
export async function checkUpload(client: string, url: string | undefined, files: string[], stealth = false): Promise<void> {
  if (stealth) return;
  const site = siteOf(url) ?? url ?? "esta página";
  const d = await ask("upload", client, site, files);
  if (d === "session" || d === "always") return;
  if (d === "timeout") throw new Error(NO_ANSWER);
  if (d === "dismissed") throw new Error(DISMISSED);
  throw new Error("O usuário recusou o envio dos arquivos.");
}

/** javascript_tool só funciona se o usuário ativar no side panel (ou em modo stealth). */
export async function checkJavascript(stealth = false): Promise<void> {
  if (stealth) return;
  const settings = await getLocal<Settings>(K.settings, DEFAULT_SETTINGS);
  if (!settings.allowJavascript) {
    throw new Error(
      "A execução de JavaScript arbitrário está desativada. O usuário pode ativá-la no painel do OBA " +
        "(\"Permitir que agentes executem JavaScript\"). Prefira read_page, find, computer e form_input.",
    );
  }
}
