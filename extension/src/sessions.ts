// Cada sessão (um agente conectado) tem seu próprio grupo de abas.
// O estado fica em chrome.storage.session para sobreviver a restarts do service worker.

import * as cdp from "./cdp";
import * as overlay from "./overlay";

import { K, type SessionView } from "./store";

export type Session = SessionView;
type Store = Record<string, Session>;

const KEY = K.sessions;

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
export async function patch(id: string, client: string, fields: Partial<Session>): Promise<void> {
  const s = await get(id, client);
  await put(id, { ...s, ...fields });
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
export async function createTab(id: string, client: string, url?: string): Promise<chrome.tabs.Tab> {
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
  const store = await load();
  const s = store[id];
  if (!s) return;
  s.stopped = stopped;
  await save(store);
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
  const store = await load();
  const s = store[id];
  delete store[id];
  await save(store);
  if (!s) return;
  for (const tab of await groupTabs(s)) {
    await overlay.remove(tab.id!);
    await cdp.detach(tab.id!);
  }
  const g = await liveGroup(s);
  if (g) await chrome.tabGroups.update(g.id, { title: `OBA · ${s.client} (desconectado)`, color: "grey" });
}

/** Novo native host = sessões antigas não existem mais. */
export async function reset(): Promise<void> {
  const store = await load();
  await Promise.all(Object.keys(store).map(close));
}
