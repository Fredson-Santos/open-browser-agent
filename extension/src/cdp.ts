// Wrapper sobre chrome.debugger (Chrome DevTools Protocol).
// Além de enviar comandos, coleta eventos por aba: console, rede e diálogos
// nativos (alert/confirm/prompt), a partir do momento em que a aba é anexada.

const PROTOCOL = "1.3";
const attached = new Set<number>();

// ---------------------------------------------------------------- buffers

export type ConsoleEntry = { t: number; level: string; text: string; url?: string; source?: string };
export type NetworkEntry = {
  id: string;
  t: number;
  method: string;
  url: string;
  type?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  size?: number;
  error?: string;
  done: boolean;
};
export type Dialog = { type: string; message: string; defaultPrompt?: string; url?: string };

const MAX_ENTRIES = 500;
const consoleLog = new Map<number, ConsoleEntry[]>();
const network = new Map<number, Map<string, NetworkEntry>>();
const dialogs = new Map<number, Dialog>();
const dialogWaiters = new Map<number, Set<(d: Dialog) => void>>();

function push<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
}

type RemoteObject = {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: { properties?: { name: string; value?: string; type: string }[]; overflow?: boolean; subtype?: string };
};

function formatArg(o: RemoteObject): string {
  if (o.type === "string") return String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === "undefined") return "undefined";
  if ("value" in o && o.type !== "object") return String(o.value);
  if (o.subtype === "null") return "null";
  if (o.preview?.properties) {
    const props = o.preview.properties.map((p) => (o.preview!.subtype === "array" ? p.value : `${p.name}: ${p.type === "string" ? JSON.stringify(p.value) : p.value}`));
    const body = props.join(", ") + (o.preview.overflow ? ", …" : "");
    return o.preview.subtype === "array" ? `[${body}]` : `{${body}}`;
  }
  return o.description ?? o.type;
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  const tabId = src.tabId;
  if (tabId === undefined) return;
  const p = (params ?? {}) as Record<string, any>;
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const list = consoleLog.get(tabId) ?? [];
      const frame = p.stackTrace?.callFrames?.[0];
      push(list, {
        t: Date.now(),
        level: p.type === "warning" ? "warn" : p.type,
        text: (p.args as RemoteObject[]).map(formatArg).join(" "),
        url: frame ? `${frame.url}:${frame.lineNumber + 1}` : undefined,
      });
      consoleLog.set(tabId, list);
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails;
      const list = consoleLog.get(tabId) ?? [];
      push(list, {
        t: Date.now(),
        level: "exception",
        text: d.exception?.description ?? d.text,
        url: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : undefined,
      });
      consoleLog.set(tabId, list);
      break;
    }
    case "Log.entryAdded": {
      const e = p.entry;
      const list = consoleLog.get(tabId) ?? [];
      push(list, { t: Date.now(), level: e.level === "warning" ? "warn" : e.level, text: e.text, url: e.url, source: e.source });
      consoleLog.set(tabId, list);
      break;
    }
    case "Network.requestWillBeSent": {
      const reqs = network.get(tabId) ?? new Map<string, NetworkEntry>();
      reqs.set(p.requestId, {
        id: p.requestId,
        t: Date.now(),
        method: p.request.method,
        url: p.request.url,
        type: p.type,
        done: false,
      });
      if (reqs.size > MAX_ENTRIES) reqs.delete(reqs.keys().next().value!);
      network.set(tabId, reqs);
      break;
    }
    case "Network.responseReceived": {
      const r = network.get(tabId)?.get(p.requestId);
      if (r) {
        r.status = p.response.status;
        r.statusText = p.response.statusText;
        r.mimeType = p.response.mimeType;
        r.type = p.type ?? r.type;
      }
      break;
    }
    case "Network.loadingFinished": {
      const r = network.get(tabId)?.get(p.requestId);
      if (r) {
        r.done = true;
        r.size = p.encodedDataLength;
      }
      break;
    }
    case "Network.loadingFailed": {
      const r = network.get(tabId)?.get(p.requestId);
      if (r) {
        r.done = true;
        r.error = p.canceled ? "cancelada" : p.blockedReason ? `bloqueada (${p.blockedReason})` : p.errorText;
      }
      break;
    }
    case "Page.javascriptDialogOpening": {
      const d: Dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt, url: p.url };
      if (d.type === "beforeunload") {
        // "Sair do site?" bloquearia a navegação pedida pelo agente.
        void chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        break;
      }
      dialogs.set(tabId, d);
      for (const w of dialogWaiters.get(tabId) ?? []) w(d);
      dialogWaiters.delete(tabId);
      break;
    }
    case "Page.javascriptDialogClosed":
      dialogs.delete(tabId);
      break;
  }
});

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId !== undefined) {
    attached.delete(src.tabId);
    dialogs.delete(src.tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  consoleLog.delete(tabId);
  network.delete(tabId);
  dialogs.delete(tabId);
});

export const consoleEntries = (tabId: number) => consoleLog.get(tabId) ?? [];
export const networkEntries = (tabId: number) => Array.from(network.get(tabId)?.values() ?? []);
export const clearConsole = (tabId: number) => consoleLog.delete(tabId);
export const clearNetwork = (tabId: number) => network.delete(tabId);
export const pendingDialog = (tabId: number) => dialogs.get(tabId);

/** Resolve quando a aba abrir um diálogo nativo (para não travar esperando um clique). */
export function waitDialog(tabId: number): { promise: Promise<Dialog>; cancel: () => void } {
  let fn!: (d: Dialog) => void;
  const promise = new Promise<Dialog>((r) => (fn = r));
  const set = dialogWaiters.get(tabId) ?? new Set();
  set.add(fn);
  dialogWaiters.set(tabId, set);
  return { promise, cancel: () => set.delete(fn) };
}

/** Erro descritivo quando a aba está bloqueada por um diálogo nativo. */
export function dialogError(d: Dialog): Error {
  const kind =
    { alert: "um alerta nativo (alert)", confirm: "uma confirmação nativa (confirm)", prompt: "uma caixa de texto nativa (prompt)" }[d.type] ??
    `um diálogo nativo (${d.type})`;
  return new Error(
    `A página está bloqueada por ${kind}: "${d.message}". ` +
      `Responda com handle_dialog (accept=true/false${d.type === "prompt" ? ", prompt_text" : ""}) antes de continuar.`,
  );
}

// ---------------------------------------------------------------- conexão

const RESTRICTED = /^(chrome|brave|edge|about|chrome-extension|devtools|view-source):/i;

export function isRestricted(url: string | undefined): boolean {
  if (!url || url === "about:blank") return false;
  return RESTRICTED.test(url) || /^https:\/\/chromewebstore\.google\.com\//.test(url);
}

async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // Após um restart do service worker a sessão anterior pode continuar ativa.
    if (!/already attached/i.test(msg)) {
      throw new Error(`não foi possível controlar a aba ${tabId}: ${msg}`);
    }
  }
  attached.add(tabId);
  const cmd = (method: string, params?: object) =>
    chrome.debugger.sendCommand({ tabId }, method, params).catch(() => {});
  // Eventos: console, erros, rede e diálogos nativos.
  await Promise.all([cmd("Runtime.enable"), cmd("Log.enable"), cmd("Network.enable", { maxTotalBufferSize: 10_000_000 }), cmd("Page.enable")]);
  // Faz a página se comportar como focada mesmo com o usuário em outra janela
  // (ex.: no terminal do agente); sem isso, foco e digitação podem falhar.
  await cmd("Emulation.setFocusEmulationEnabled", { enabled: true });
  await waitViewportStable(tabId);
}

/** Anexa o depurador para começar a coletar console/rede desde já. */
export async function track(tabId: number): Promise<void> {
  try {
    await attach(tabId);
  } catch {
    /* páginas internas: sem coleta */
  }
}

/**
 * Ao anexar, o navegador mostra a barra "está depurando", que encolhe a
 * viewport logo em seguida. Espera a altura estabilizar para que screenshots
 * e coordenadas usem o tamanho final.
 */
async function waitViewportStable(tabId: number): Promise<void> {
  const height = async () => {
    try {
      const r = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "innerHeight",
        returnByValue: true,
        timeout: 500,
      })) as { result?: { value?: number } };
      return r.result?.value ?? 0;
    } catch {
      return 0;
    }
  };
  let last = await height();
  let stableFor = 0;
  for (let waited = 0; waited < 1500 && stableFor < 300; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
    const h = await height();
    stableFor = h === last ? stableFor + 100 : 0;
    last = h;
  }
}

/** Solta o depurador da aba (remove a barra "está depurando este navegador"). */
export async function detach(tabId: number): Promise<void> {
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* não estava anexado */
  }
}

export async function send<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  await attach(tabId);
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}
