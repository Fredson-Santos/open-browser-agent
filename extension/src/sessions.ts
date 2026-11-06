// Cada sessão (um agente conectado) tem seu próprio grupo de abas.
// O estado fica em chrome.storage.session para sobreviver a restarts do service worker.

import * as cdp from "./cdp";
import * as overlay from "./overlay";

import { CHAT_SESSION, K, type SessionView } from "./store";

export type Session = SessionView;
type Store = Record<string, Session>;

const KEY = K.sessions;

// Toda alteração lê o mapa inteiro do storage e grava de volta. Agentes chamam
// ferramentas em paralelo, então as alterações passam por esta fila: sem ela,
// duas chamadas simultâneas (ex.: dois tabs_create sem grupo) se sobrescrevem
// e uma delas perde o groupId.
let queue: Promise<unknown> = Promise.resolve();

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function load(): Promise<Store> {
  const data = await chrome.storage.session.get(KEY);
  return (data[KEY] as Store | undefined) ?? {};
}

async function save(store: Store): Promise<void> {
  await chrome.storage.session.set({ [KEY]: store });
}

async function get(id: string, client: string): Promise<Session> {
  const store = await load();
  const s = store[id] ?? { client };
  s.client = client;
  return s;
}

async function put(id: string, s: Session): Promise<void> {
  const store = await load();
  store[id] = s;
  await save(store);
}

export async function info(id: string): Promise<Session | undefined> {
  return (await load())[id];
}

/** Atualiza campos da sessão (aprovação, sites liberados nesta sessão…). */
export function patch(id: string, client: string, fields: Partial<Session>): Promise<void> {
  return locked(async () => {
    const s = await get(id, client);
    await put(id, { ...s, ...fields });
  });
}

/** Libera um site só nesta sessão (lido e gravado dentro da fila, para não perder outro site liberado ao mesmo tempo). */
export function addSite(id: string, client: string, site: string): Promise<void> {
  return locked(async () => {
    const s = await get(id, client);
    const sites = s.sites ?? [];
    if (!sites.includes(site)) await put(id, { ...s, sites: [...sites, site] });
  });
}

/** Encontra a sessão dona de um grupo de abas. */
export async function byGroup(groupId: number | undefined): Promise<[string, Session] | undefined> {
  if (groupId === undefined || groupId < 0) return undefined;
  const store = await load();
  return Object.entries(store).find(([, s]) => s.groupId === groupId);
}

/** Retorna o grupo da sessão, se ainda existir no navegador. */
async function liveGroup(s: Session): Promise<chrome.tabGroups.TabGroup | undefined> {
  if (s.groupId === undefined) return undefined;
  try {
    return await chrome.tabGroups.get(s.groupId);
  } catch {
    return undefined; // grupo some quando a última aba dele é fechada
  }
}

async function groupTabs(s: Session | undefined): Promise<chrome.tabs.Tab[]> {
  const g = s && (await liveGroup(s));
  return g ? chrome.tabs.query({ groupId: g.id }) : [];
}

export async function listTabs(id: string, client: string): Promise<chrome.tabs.Tab[]> {
  return groupTabs(await get(id, client));
}

/** Cria uma aba dentro do grupo da sessão (criando o grupo se preciso). */
export function createTab(id: string, client: string, url?: string): Promise<chrome.tabs.Tab> {
  return locked(() => createTabUnlocked(id, client, url));
}

async function createTabUnlocked(id: string, client: string, url?: string): Promise<chrome.tabs.Tab> {
  const s = await get(id, client);
  const g = await liveGroup(s);

  let windowId = g?.windowId;
  if (windowId === undefined) {
    try {
      windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
    } catch {
      windowId = undefined;
    }
  }
  if (windowId === undefined) {
    windowId = (await chrome.windows.create({ focused: true }))?.id;
  }

  const tab = await chrome.tabs.create({ windowId, url: url ?? "about:blank", active: true });
  const tabId = tab.id!;
  if (g) {
    await chrome.tabs.group({ groupId: g.id, tabIds: [tabId] });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: `OBA · ${client}`, color: "cyan" });
    s.groupId = groupId;
  }
  await put(id, s);
  return chrome.tabs.get(tabId);
}

/**
 * Coloca uma aba já aberta (a aba atual do usuário, no chat embutido) no grupo
 * da sessão, criando o grupo na janela dela se preciso.
 */
export function adoptTab(id: string, client: string, tabId: number): Promise<chrome.tabs.Tab> {
  return locked(() => adoptTabUnlocked(id, client, tabId));
}

async function adoptTabUnlocked(id: string, client: string, tabId: number): Promise<chrome.tabs.Tab> {
  const s = await get(id, client);
  const g = await liveGroup(s);
  const tab = await chrome.tabs.get(tabId);
  if (g && tab.groupId === g.id) return tab;
  if (g && g.windowId === tab.windowId) {
    await chrome.tabs.group({ groupId: g.id, tabIds: [tabId] });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: `OBA · ${client}`, color: "cyan" });
    s.groupId = groupId;
  }
  await put(id, s);
  return chrome.tabs.get(tabId);
}

/** Garante que a aba pertence ao grupo da sessão. */
export async function ownedTab(id: string, client: string, tabId: unknown): Promise<chrome.tabs.Tab> {
  if (typeof tabId !== "number") throw new Error("tab_id é obrigatório (use tabs_context).");
  const s = await get(id, client);
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`a aba ${tabId} não existe mais; chame tabs_context.`);
  }
  if (s.groupId === undefined || tab.groupId !== s.groupId) {
    throw new Error(`a aba ${tabId} não pertence ao grupo desta sessão; chame tabs_context.`);
  }
  return tab;
}

/** Pausa ou retoma a sessão; pausar também solta o depurador das abas dela. */
export async function setStopped(id: string, stopped: boolean): Promise<void> {
  const s = await locked(async () => {
    const store = await load();
    const s = store[id];
    if (!s) return undefined;
    s.stopped = stopped;
    await save(store);
    return s;
  });
  if (!s) return;
  const g = await liveGroup(s);
  if (g) {
    await chrome.tabGroups.update(g.id, {
      title: stopped ? `OBA · ${s.client} (pausado)` : `OBA · ${s.client}`,
      color: stopped ? "red" : "cyan",
    });
  }
  for (const tab of await groupTabs(s)) {
    await overlay.setStopped(tab.id!, stopped);
    if (stopped) await cdp.detach(tab.id!);
  }
}

/** Agente desconectou: remove indicadores e solta o depurador das abas dele. */
export async function close(id: string): Promise<void> {
  const s = await forget(id);
  if (!s) return;
  for (const tab of await groupTabs(s)) {
    await overlay.remove(tab.id!);
    await cdp.detach(tab.id!);
  }
  const g = await liveGroup(s);
  if (g) await chrome.tabGroups.update(g.id, { title: `OBA · ${s.client} (desconectado)`, color: "grey" });
}

/** Remove a sessão do armazenamento e devolve o que ela era. */
function forget(id: string): Promise<Session | undefined> {
  return locked(async () => {
    const store = await load();
    const s = store[id];
    if (!s) return undefined;
    delete store[id];
    await save(store);
    return s;
  });
}

/**
 * Fim de uma rodada do chat embutido: tira overlay e depurador das abas (some a
 * barra "está depurando" e o beforeunload volta ao normal), mas mantém o grupo,
 * para a conversa continuar usando os mesmos tab_id.
 */
export async function idle(id: string): Promise<void> {
  for (const tab of await groupTabs(await info(id))) {
    await overlay.remove(tab.id!);
    await cdp.detach(tab.id!);
  }
}

/** Encerra a sessão por completo e devolve as abas ao usuário, fora do grupo. */
export async function release(id: string): Promise<void> {
  const s = await forget(id);
  const tabs = await groupTabs(s);
  for (const tab of tabs) {
    await overlay.remove(tab.id!);
    await cdp.detach(tab.id!);
  }
  const ids = tabs.map((t) => t.id!);
  if (ids.length) await chrome.tabs.ungroup(ids as [number, ...number[]]).catch(() => {});
}

/** Novo native host = sessões MCP antigas não existem mais (o chat embutido não depende do host). */
export async function reset(): Promise<void> {
  const store = await load();
  await Promise.all(Object.keys(store).filter((id) => id !== CHAT_SESSION).map(close));
}
