// Cada sessão (um agente conectado) tem seu próprio grupo de abas.
// O estado fica em chrome.storage.session para sobreviver a restarts do service worker.

type Session = { client: string; groupId?: number };
type Store = Record<string, Session>;

const KEY = "oba.sessions";

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

/** Retorna o grupo da sessão, se ainda existir no navegador. */
async function liveGroup(s: Session): Promise<chrome.tabGroups.TabGroup | undefined> {
  if (s.groupId === undefined) return undefined;
  try {
    return await chrome.tabGroups.get(s.groupId);
  } catch {
    return undefined; // grupo some quando a última aba dele é fechada
  }
}

export async function listTabs(id: string, client: string): Promise<chrome.tabs.Tab[]> {
  const s = await get(id, client);
  const g = await liveGroup(s);
  if (!g) return [];
  return chrome.tabs.query({ groupId: g.id });
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

export async function close(id: string): Promise<void> {
  const store = await load();
  const s = store[id];
  delete store[id];
  await save(store);
  const g = s && (await liveGroup(s));
  if (g) await chrome.tabGroups.update(g.id, { title: `OBA · ${s.client} (desconectado)`, color: "grey" });
}

/** Novo native host = sessões antigas não existem mais. */
export async function reset(): Promise<void> {
  const store = await load();
  await Promise.all(Object.keys(store).map(close));
}
