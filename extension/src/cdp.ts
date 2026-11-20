// Wrapper sobre chrome.debugger (Chrome DevTools Protocol).
// Além de enviar comandos, coleta eventos por aba: console, rede e diálogos
// nativos (alert/confirm/prompt), a partir do momento em que a aba é anexada.

const PROTOCOL = "1.3";
const attached = new Set<number>();

// ---------------------------------------------------------------- buffers

export type ConsoleEntry = { t: number; level: string; text: string; url?: string; source?: string };
export type RedirectHop = {
  url: string;
  status: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
};
export type NetworkEntry = {
  id: string;
  t: number;
  method: string;
  url: string;
  protocol?: string;
  type?: string;
  requestHeaders?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  body?: string;
  bodyBase64?: boolean;
  bodyBytes?: number;
  bodyTruncated?: boolean;
  bodyError?: string;
  redirects?: RedirectHop[];
  size?: number;
  error?: string;
  done: boolean;
};
export type Dialog = { type: string; message: string; defaultPrompt?: string; url?: string };
export type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: string;
};
export type SetCookieParams = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
};
export type HeaderState = {
  headers: Record<string, string>;
  userAgent?: string;
};
export type HeaderEntry = { name: string; value: string };
export type BodyReplacement = {
  find: string;
  replace: string;
  regex?: boolean;
};
export type InterceptRuleInput = {
  stage: "Request" | "Response";
  urlPattern?: string;
  method?: string;
  statusFilter?: number;
  block?: boolean;
  overrideUrl?: string;
  overrideMethod?: string;
  overrideStatus?: number;
  overrideStatusText?: string;
  setHeaders?: Record<string, string>;
  removeHeaders?: string[];
  overrideBody?: string;
  replaceBody?: BodyReplacement[];
};
export type InterceptRule = InterceptRuleInput & {
  id: string;
  urlPattern: string;
  hits: number;
};
type OneShotOverride = {
  id: string;
  url: string;
  urlPattern: string;
  method?: string;
  setHeaders: Record<string, string>;
  removeHeaders?: string[];
};

const MAX_ENTRIES = 500;
const MAX_CAPTURED_BODY_CHARS = 256 * 1024;
const FETCH_PAUSE_TIMEOUT_MS = 8_000;
const SKIP_PROACTIVE_BODY_TYPES = new Set(["Image", "Font", "Media"]);
const consoleLog = new Map<number, ConsoleEntry[]>();
const network = new Map<number, Map<string, NetworkEntry>>();
const extraReqHeaders = new Map<number, Map<string, Record<string, string>>>();
const extraRespInfo = new Map<number, Map<string, { headers?: Record<string, string>; statusCode?: number }>>();
const extraTabHeaders = new Map<number, HeaderState>();
const interceptRules = new Map<number, InterceptRule[]>();
const oneShotOverrides = new Map<number, OneShotOverride[]>();
const fetchEnabledTabs = new Set<number>();
const stealthTabs = new Set<number>();
const stealthScriptRegistered = new Set<number>();
const dialogs = new Map<number, Dialog>();
const dialogWaiters = new Map<number, Set<(d: Dialog) => void>>();
let ruleSeq = 0;

const STEALTH_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined, configurable: true });
  } catch {}
  try {
    if (!window.chrome) Object.defineProperty(window, "chrome", { value: { runtime: {} }, configurable: true });
  } catch {}
})();`;

export function cleanStealthUserAgent(raw = navigator.userAgent): string {
  return raw
    .replace(/HeadlessChrome\//gi, "Chrome/")
    .replace(/Headless/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function applyStealthUserAgent(tabId: number): Promise<void> {
  if (extraTabHeaders.get(tabId)?.userAgent !== undefined) return;
  const clean = cleanStealthUserAgent(navigator.userAgent);
  if (!clean) return;
  await chrome.debugger
    .sendCommand({ tabId }, "Network.setUserAgentOverride", { userAgent: clean })
    .catch(() => {});
}

export function setStealthTab(tabId: number, enabled: boolean): void {
  if (enabled) {
    stealthTabs.add(tabId);
    if (attached.has(tabId) && !stealthScriptRegistered.has(tabId)) {
      stealthScriptRegistered.add(tabId);
      void chrome.debugger
        .sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_INIT_SCRIPT })
        .catch(() => {});
      void applyStealthUserAgent(tabId);
    }
  } else {
    stealthTabs.delete(tabId);
  }
}

function push<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
}

function mergeHeaders(
  existing: Record<string, string> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!incoming) return existing;
  const out: Record<string, string> = {};
  const byLower = new Map<string, string>();
  for (const [k, v] of Object.entries(existing ?? {})) {
    if (k.startsWith(":")) continue;
    out[k] = v;
    byLower.set(k.toLowerCase(), k);
  }
  for (const [rawKey, rawVal] of Object.entries(incoming)) {
    if (rawKey.startsWith(":") || rawVal === undefined || rawVal === null) continue;
    const val = Array.isArray(rawVal) ? rawVal.map(String).join("\n") : String(rawVal);
    const lower = rawKey.toLowerCase();
    const prevKey = byLower.get(lower);
    if (prevKey !== undefined && prevKey !== rawKey) delete out[prevKey];
    byLower.set(lower, rawKey);
    out[rawKey] = val;
  }
  return Object.keys(out).length > 0 ? out : existing;
}

function setMapBounded<V>(outer: Map<number, Map<string, V>>, tabId: number, key: string, value: V): void {
  const inner = outer.get(tabId) ?? new Map<string, V>();
  inner.set(key, value);
  if (inner.size > MAX_ENTRIES) inner.delete(inner.keys().next().value!);
  outer.set(tabId, inner);
}

function takeMapValue<V>(outer: Map<number, Map<string, V>>, tabId: number, key: string): V | undefined {
  const inner = outer.get(tabId);
  if (!inner) return undefined;
  const val = inner.get(key);
  if (val !== undefined) inner.delete(key);
  return val;
}

function capBodyText(text: string): { value: string; truncated: boolean } {
  if (text.length <= MAX_CAPTURED_BODY_CHARS) return { value: text, truncated: false };
  return { value: text.slice(0, MAX_CAPTURED_BODY_CHARS), truncated: true };
}

const STATUS_PHRASES: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function base64ToUtf8(b64: string): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(base64ToBytes(b64));
}

function normalizeUrlPattern(raw?: string): string {
  const s = (raw ?? "").trim();
  if (!s || s === "*") return "*";
  if (s.includes("*") || s.includes("?") || /^https?:\/\//i.test(s)) return s;
  return `*${s}*`;
}

function matchUrlPattern(pattern: string, url: string): boolean {
  if (!pattern || pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(url);
}

function isTextContentType(headers: HeaderEntry[]): boolean {
  const ct = headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
  if (!ct) return true;
  return /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|svg|graphql|csv/i.test(ct);
}

function objectHeadersToEntries(headers: Record<string, unknown> | undefined): HeaderEntry[] {
  const list: HeaderEntry[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.startsWith(":") || v === undefined || v === null) continue;
    for (const part of String(v).split(/\r?\n/)) {
      list.push({ name: k, value: part });
    }
  }
  return list;
}

function headerEntriesToRecord(entries: HeaderEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  const byLower = new Map<string, string>();
  for (const h of entries) {
    if (!h.name || h.name.startsWith(":")) continue;
    const low = h.name.toLowerCase();
    const key = byLower.get(low) ?? h.name;
    byLower.set(low, key);
    out[key] = key in out ? `${out[key]}\n${h.value}` : h.value;
  }
  return out;
}

function applyHeaderMutations(
  initial: HeaderEntry[],
  setHeaders?: Record<string, string>,
  removeHeaders?: string[],
): HeaderEntry[] {
  let next = initial.map((h) => ({ name: h.name, value: h.value }));
  if (removeHeaders?.length) {
    const drop = new Set(removeHeaders.map((k) => k.toLowerCase()));
    next = next.filter((h) => !drop.has(h.name.toLowerCase()));
  }
  if (setHeaders) {
    for (const [k, v] of Object.entries(setHeaders)) {
      if (!k.trim() || k.startsWith(":")) continue;
      const low = k.toLowerCase();
      next = next.filter((h) => h.name.toLowerCase() !== low);
      for (const part of String(v).split(/\r?\n/)) {
        next.push({ name: k, value: part });
      }
    }
  }
  return next;
}

function applyBodyReplacements(
  body: string,
  replacements: BodyReplacement[],
): { body: string; changed: boolean } {
  let cur = body;
  let changed = false;
  for (const r of replacements) {
    const next = r.regex ? cur.replace(new RegExp(r.find, "g"), r.replace) : cur.split(r.find).join(r.replace);
    if (next !== cur) changed = true;
    cur = next;
  }
  return { body: cur, changed };
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
      const reqId = String(p.requestId);
      const prev = reqs.get(reqId);
      let redirects = prev?.redirects;
      if (prev && p.redirectResponse) {
        const rr = p.redirectResponse as {
          url?: string;
          status: number;
          statusText?: string;
          headers?: Record<string, unknown>;
        };
        redirects = [
          ...(redirects ?? []),
          {
            url: rr.url || prev.url,
            status: rr.status,
            statusText: rr.statusText,
            responseHeaders: mergeHeaders(prev.responseHeaders, rr.headers),
          },
        ];
      }
      const reqObj = (p.request ?? {}) as {
        method: string;
        url: string;
        headers?: Record<string, unknown>;
        postData?: string;
        hasPostData?: boolean;
      };
      const pendingReqHeaders = takeMapValue(extraReqHeaders, tabId, reqId);
      const requestHeaders = mergeHeaders(mergeHeaders(undefined, reqObj.headers), pendingReqHeaders);
      const rawPostData = typeof reqObj.postData === "string" ? reqObj.postData : undefined;
      const postData = rawPostData !== undefined ? capBodyText(rawPostData).value : undefined;
      const hasPostData = Boolean(reqObj.hasPostData || rawPostData !== undefined);
      reqs.set(reqId, {
        id: reqId,
        t: Date.now(),
        method: reqObj.method,
        url: reqObj.url,
        type: p.type,
        requestHeaders,
        postData,
        hasPostData,
        redirects,
        done: false,
      });
      if (reqs.size > MAX_ENTRIES) reqs.delete(reqs.keys().next().value!);
      network.set(tabId, reqs);
      if (reqObj.hasPostData && rawPostData === undefined) {
        void chrome.debugger
          .sendCommand({ tabId }, "Network.getRequestPostData", { requestId: reqId })
          .then((res) => {
            const data = (res as { postData?: string } | undefined)?.postData;
            const cur = network.get(tabId)?.get(reqId);
            if (cur && typeof data === "string") {
              cur.postData = capBodyText(data).value;
            }
          })
          .catch(() => {});
      }
      break;
    }
    case "Network.requestWillBeSentExtraInfo": {
      const reqId = String(p.requestId);
      const headers = p.headers as Record<string, unknown> | undefined;
      const r = network.get(tabId)?.get(reqId);
      if (r) {
        r.requestHeaders = mergeHeaders(r.requestHeaders, headers);
      } else {
        const prev = extraReqHeaders.get(tabId)?.get(reqId);
        const merged = mergeHeaders(prev, headers);
        if (merged) setMapBounded(extraReqHeaders, tabId, reqId, merged);
      }
      break;
    }
    case "Network.responseReceived": {
      const reqId = String(p.requestId);
      const r = network.get(tabId)?.get(reqId);
      if (r) {
        const resp = (p.response ?? {}) as {
          status?: number;
          statusText?: string;
          mimeType?: string;
          protocol?: string;
          headers?: Record<string, unknown>;
        };
        r.status = resp.status;
        r.statusText = resp.statusText;
        r.mimeType = resp.mimeType;
        r.protocol = resp.protocol ?? r.protocol;
        r.type = p.type ?? r.type;
        const extra = takeMapValue(extraRespInfo, tabId, reqId);
        r.responseHeaders = mergeHeaders(mergeHeaders(r.responseHeaders, resp.headers), extra?.headers);
        if (r.status === undefined && extra?.statusCode !== undefined) {
          r.status = extra.statusCode;
        }
      }
      break;
    }
    case "Network.responseReceivedExtraInfo": {
      const reqId = String(p.requestId);
      const headers = p.headers as Record<string, unknown> | undefined;
      const statusCode = typeof p.statusCode === "number" ? p.statusCode : undefined;
      const r = network.get(tabId)?.get(reqId);
      if (r) {
        r.responseHeaders = mergeHeaders(r.responseHeaders, headers);
        if (r.status === undefined && statusCode !== undefined) {
          r.status = statusCode;
        }
      } else {
        const prev = extraRespInfo.get(tabId)?.get(reqId);
        const merged = mergeHeaders(prev?.headers, headers);
        setMapBounded(extraRespInfo, tabId, reqId, {
          headers: merged,
          statusCode: statusCode ?? prev?.statusCode,
        });
      }
      break;
    }
    case "Network.loadingFinished": {
      const reqId = String(p.requestId);
      const r = network.get(tabId)?.get(reqId);
      if (r) {
        r.done = true;
        r.size = p.encodedDataLength;
        if (r.body === undefined && r.bodyBase64 === undefined && !SKIP_PROACTIVE_BODY_TYPES.has(r.type ?? "")) {
          void chrome.debugger
            .sendCommand({ tabId }, "Network.getResponseBody", { requestId: reqId })
            .then((res) => {
              const out = res as { body?: string; base64Encoded?: boolean } | undefined;
              const cur = network.get(tabId)?.get(reqId);
              if (!cur || !out || typeof out.body !== "string") return;
              if (out.base64Encoded) {
                cur.bodyBase64 = true;
                cur.bodyBytes = Math.round(out.body.length * 0.75);
              } else {
                cur.bodyBase64 = false;
                cur.bodyBytes = out.body.length;
                const capped = capBodyText(out.body);
                cur.body = capped.value;
                cur.bodyTruncated = capped.truncated;
              }
            })
            .catch((e) => {
              const cur = network.get(tabId)?.get(reqId);
              if (cur) cur.bodyError = String((e as Error)?.message ?? e);
            });
        }
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
    case "Fetch.requestPaused":
      void handleFetchPaused(tabId, p);
      break;
  }
});

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId !== undefined) {
    attached.delete(src.tabId);
    fetchEnabledTabs.delete(src.tabId);
    stealthScriptRegistered.delete(src.tabId);
    dialogs.delete(src.tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  consoleLog.delete(tabId);
  network.delete(tabId);
  extraReqHeaders.delete(tabId);
  extraRespInfo.delete(tabId);
  extraTabHeaders.delete(tabId);
  interceptRules.delete(tabId);
  oneShotOverrides.delete(tabId);
  fetchEnabledTabs.delete(tabId);
  stealthTabs.delete(tabId);
  stealthScriptRegistered.delete(tabId);
  dialogs.delete(tabId);
});

export const consoleEntries = (tabId: number) => consoleLog.get(tabId) ?? [];
export const networkEntries = (tabId: number) => Array.from(network.get(tabId)?.values() ?? []);
export const clearConsole = (tabId: number) => consoleLog.delete(tabId);
export const clearNetwork = (tabId: number) => {
  network.delete(tabId);
  extraReqHeaders.delete(tabId);
  extraRespInfo.delete(tabId);
};
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
  await Promise.all([
    cmd("Runtime.enable"),
    cmd("Log.enable"),
    cmd("Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 }),
    cmd("Page.enable"),
  ]);
  const hdrs = extraTabHeaders.get(tabId);
  if (hdrs) {
    if (Object.keys(hdrs.headers).length > 0) {
      await cmd("Network.setExtraHTTPHeaders", { headers: hdrs.headers });
    }
    if (hdrs.userAgent !== undefined) {
      await cmd("Network.setUserAgentOverride", { userAgent: hdrs.userAgent });
    }
  }
  const patterns = buildFetchPatterns(tabId);
  if (patterns.length > 0) {
    await cmd("Fetch.enable", { patterns });
    fetchEnabledTabs.add(tabId);
  }
  const isStealth = stealthTabs.has(tabId);
  if (isStealth) {
    stealthScriptRegistered.add(tabId);
    await cmd("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_INIT_SCRIPT });
    if (hdrs?.userAgent === undefined) {
      await applyStealthUserAgent(tabId);
    }
  }
  // Faz a página se comportar como focada mesmo com o usuário em outra janela
  // (ex.: no terminal do agente); sem isso, foco e digitação podem falhar.
  await cmd("Emulation.setFocusEmulationEnabled", { enabled: true });
  if (!isStealth) await waitViewportStable(tabId);
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

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- cookies

export async function getCookies(tabId: number, opts?: { urls?: string[]; all?: boolean }): Promise<CdpCookie[]> {
  if (opts?.all) {
    const res = await send<{ cookies?: CdpCookie[] }>(tabId, "Storage.getCookies", {});
    return res?.cookies ?? [];
  }
  const params = opts?.urls?.length ? { urls: opts.urls } : {};
  const res = await send<{ cookies?: CdpCookie[] }>(tabId, "Network.getCookies", params);
  return res?.cookies ?? [];
}

export async function setCookie(tabId: number, params: SetCookieParams): Promise<boolean> {
  const payload = omitUndefined(params as unknown as Record<string, unknown>);
  const res = await send<{ success?: boolean }>(tabId, "Network.setCookie", payload);
  return Boolean(res?.success);
}

export async function deleteCookies(
  tabId: number,
  params: { name: string; url?: string; domain?: string; path?: string },
): Promise<void> {
  const payload = omitUndefined(params as unknown as Record<string, unknown>);
  await send(tabId, "Network.deleteCookies", payload);
}

export async function clearAllCookies(tabId: number): Promise<void> {
  await send(tabId, "Network.clearBrowserCookies", {});
}

// ---------------------------------------------------------------- headers extras

export function getTabHeaders(tabId: number): HeaderState {
  const st = extraTabHeaders.get(tabId);
  return {
    headers: { ...(st?.headers ?? {}) },
    ...(st?.userAgent !== undefined ? { userAgent: st.userAgent } : {}),
  };
}

export async function setTabHeaders(
  tabId: number,
  opts: { headers?: Record<string, string>; remove?: string[]; replace?: boolean; userAgent?: string },
): Promise<HeaderState> {
  const prev = extraTabHeaders.get(tabId);
  let nextHeaders: Record<string, string> = opts.replace ? {} : { ...(prev?.headers ?? {}) };
  if (opts.remove?.length) {
    const drop = new Set(opts.remove.map((k) => k.toLowerCase()));
    for (const k of Object.keys(nextHeaders)) {
      if (drop.has(k.toLowerCase())) delete nextHeaders[k];
    }
  }
  if (opts.headers) {
    nextHeaders = mergeHeaders(nextHeaders, opts.headers) ?? {};
  }
  await send(tabId, "Network.setExtraHTTPHeaders", { headers: nextHeaders });

  let nextUA = prev?.userAgent;
  if (opts.userAgent !== undefined) {
    const appliedUA =
      opts.userAgent === ""
        ? (stealthTabs.has(tabId) ? cleanStealthUserAgent(navigator.userAgent) : "")
        : opts.userAgent;
    await send(tabId, "Network.setUserAgentOverride", { userAgent: appliedUA });
    nextUA = opts.userAgent === "" ? undefined : opts.userAgent;
  }

  if (Object.keys(nextHeaders).length === 0 && nextUA === undefined) {
    extraTabHeaders.delete(tabId);
    return { headers: {} };
  }
  const saved: HeaderState = {
    headers: nextHeaders,
    ...(nextUA !== undefined ? { userAgent: nextUA } : {}),
  };
  extraTabHeaders.set(tabId, saved);
  return {
    headers: { ...saved.headers },
    ...(saved.userAgent !== undefined ? { userAgent: saved.userAgent } : {}),
  };
}

export async function clearTabHeaders(tabId: number): Promise<void> {
  const prev = extraTabHeaders.get(tabId);
  await send(tabId, "Network.setExtraHTTPHeaders", { headers: {} });
  if (prev?.userAgent !== undefined) {
    const restoredUA = stealthTabs.has(tabId) ? cleanStealthUserAgent(navigator.userAgent) : "";
    await send(tabId, "Network.setUserAgentOverride", { userAgent: restoredUA });
  }
  extraTabHeaders.delete(tabId);
}

// ---------------------------------------------------------------- web storage

export type StorageAction = "list" | "get" | "set" | "delete" | "clear";
export type StorageScope = "local" | "session" | "both";

export async function execStorage(
  tabId: number,
  opts: { action: StorageAction; type: StorageScope; key?: string; value?: string },
): Promise<unknown> {
  const payload = JSON.stringify(opts);
  const expression = `(() => {
    try {
      const o = ${payload};
      const targets = o.type === "both" ? ["local", "session"] : [o.type];
      const storeOf = (t) => (t === "local" ? window.localStorage : window.sessionStorage);
      if (o.action === "list") {
        const filter = typeof o.key === "string" && o.key ? o.key.toLowerCase() : "";
        const res = {};
        for (const t of targets) {
          const s = storeOf(t);
          const map = {};
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (k !== null && (!filter || k.toLowerCase().includes(filter))) {
              map[k] = s.getItem(k);
            }
          }
          res[t] = map;
        }
        return res;
      }
      if (o.action === "get") {
        if (targets.length === 1) {
          const s = storeOf(targets[0]);
          const val = s.getItem(o.key);
          return { type: targets[0], key: o.key, found: val !== null, value: val };
        }
        const res = {};
        for (const t of targets) {
          const val = storeOf(t).getItem(o.key);
          res[t] = { found: val !== null, value: val };
        }
        return res;
      }
      if (o.action === "set") {
        for (const t of targets) storeOf(t).setItem(o.key, o.value);
        return { ok: true, type: o.type, key: o.key, length: String(o.value).length };
      }
      if (o.action === "delete") {
        const removed = {};
        for (const t of targets) {
          const s = storeOf(t);
          const existed = s.getItem(o.key) !== null;
          s.removeItem(o.key);
          removed[t] = existed;
        }
        return { ok: true, key: o.key, removed };
      }
      if (o.action === "clear") {
        const cleared = {};
        for (const t of targets) {
          const s = storeOf(t);
          const count = s.length;
          s.clear();
          cleared[t] = count;
        }
        return { ok: true, cleared };
      }
      return { __error: "ação desconhecida: " + o.action };
    } catch (e) {
      return { __error: e && e.message ? e.message : String(e) };
    }
  })()`;
  const r = await send<{
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string }; text: string };
  }>(tabId, "Runtime.evaluate", { expression, returnByValue: true, timeout: 10_000 });
  if (r.exceptionDetails) {
    throw new Error(`exceção: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  const val = r.result?.value;
  if (val && typeof val === "object" && "__error" in val) {
    throw new Error(String((val as { __error: unknown }).__error));
  }
  return val;
}

// ---------------------------------------------------------------- intercept (Fetch)

function buildFetchPatterns(tabId: number): { urlPattern: string; requestStage: "Request" | "Response" }[] {
  const seen = new Set<string>();
  const out: { urlPattern: string; requestStage: "Request" | "Response" }[] = [];
  for (const r of interceptRules.get(tabId) ?? []) {
    const key = `${r.stage}|${r.urlPattern}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ urlPattern: r.urlPattern, requestStage: r.stage });
    }
  }
  for (const o of oneShotOverrides.get(tabId) ?? []) {
    const key = `Request|${o.urlPattern}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ urlPattern: o.urlPattern, requestStage: "Request" });
    }
  }
  return out;
}

async function syncFetch(tabId: number): Promise<void> {
  const patterns = buildFetchPatterns(tabId);
  if (patterns.length === 0) {
    if (fetchEnabledTabs.has(tabId) && attached.has(tabId)) {
      await chrome.debugger.sendCommand({ tabId }, "Fetch.disable").catch(() => {});
    }
    fetchEnabledTabs.delete(tabId);
    return;
  }
  await send(tabId, "Fetch.enable", { patterns });
  fetchEnabledTabs.add(tabId);
}

async function handleFetchPaused(tabId: number, p: Record<string, any>): Promise<void> {
  const requestId = String(p.requestId ?? "");
  if (!requestId) return;
  const networkId = p.networkId ? String(p.networkId) : undefined;
  const req = (p.request ?? {}) as {
    url?: string;
    method?: string;
    headers?: Record<string, unknown>;
    postData?: string;
    postDataEntries?: { bytes?: string }[];
  };
  const reqUrl = String(req.url ?? "");
  const reqMethod = String(req.method ?? "GET").toUpperCase();
  const isResponseStage = p.responseStatusCode !== undefined || p.responseErrorReason !== undefined;

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const resumeSafe = async () => {
    if (settled) return;
    settle();
    if (isResponseStage && p.responseErrorReason === undefined) {
      await chrome.debugger
        .sendCommand({ tabId }, "Fetch.continueResponse", { requestId })
        .catch(() => chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId }).catch(() => {}));
    } else {
      await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId }).catch(() => {});
    }
  };
  timer = setTimeout(() => void resumeSafe(), FETCH_PAUSE_TIMEOUT_MS);

  try {
    if (!isResponseStage) {
      const matched = (interceptRules.get(tabId) ?? []).filter(
        (r) =>
          r.stage === "Request" &&
          matchUrlPattern(r.urlPattern, reqUrl) &&
          (!r.method || r.method.toUpperCase() === reqMethod),
      );
      const reqNoHash = reqUrl.replace(/#.*$/, "");
      const oneShots = oneShotOverrides.get(tabId);
      let consumedOneShot: OneShotOverride | undefined;
      if (oneShots?.length) {
        const idx = oneShots.findIndex((o) => o.url === reqNoHash && (!o.method || o.method === reqMethod));
        if (idx >= 0) {
          consumedOneShot = oneShots.splice(idx, 1)[0];
          if (oneShots.length === 0) oneShotOverrides.delete(tabId);
        }
      }

      if (matched.length === 0 && !consumedOneShot) {
        await resumeSafe();
        return;
      }

      const blocking = matched.find((r) => r.block);
      if (blocking) {
        blocking.hits++;
        await chrome.debugger.sendCommand({ tabId }, "Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        });
        settle();
        return;
      }

      let curUrl = reqUrl;
      let curMethod = reqMethod;
      let curHeaders = objectHeadersToEntries(req.headers);
      let curPostData: string | undefined = typeof req.postData === "string" ? req.postData : undefined;
      if (curPostData === undefined && Array.isArray(req.postDataEntries)) {
        const parts: string[] = [];
        for (const entry of req.postDataEntries) {
          if (typeof entry?.bytes === "string") parts.push(base64ToUtf8(entry.bytes));
        }
        if (parts.length > 0) curPostData = parts.join("");
      }

      let urlMutated = false;
      let methodMutated = false;
      let headersMutated = false;
      let postDataMutated = false;

      for (const r of matched) {
        r.hits++;
        if (r.overrideUrl !== undefined && r.overrideUrl !== curUrl) {
          curUrl = r.overrideUrl;
          urlMutated = true;
        }
        if (r.overrideMethod !== undefined && r.overrideMethod !== curMethod) {
          curMethod = r.overrideMethod;
          methodMutated = true;
        }
        if (r.setHeaders || r.removeHeaders?.length) {
          curHeaders = applyHeaderMutations(curHeaders, r.setHeaders, r.removeHeaders);
          headersMutated = true;
        }
        if (r.overrideBody !== undefined) {
          curPostData = r.overrideBody;
          postDataMutated = true;
        } else if (r.replaceBody?.length && curPostData !== undefined) {
          const rep = applyBodyReplacements(curPostData, r.replaceBody);
          if (rep.changed) {
            curPostData = rep.body;
            postDataMutated = true;
          }
        }
      }

      if (consumedOneShot) {
        curHeaders = applyHeaderMutations(curHeaders, consumedOneShot.setHeaders, consumedOneShot.removeHeaders);
        headersMutated = true;
      }

      if (!urlMutated && !methodMutated && !headersMutated && !postDataMutated) {
        await resumeSafe();
        return;
      }

      if (postDataMutated) {
        curHeaders = curHeaders.filter((h) => h.name.toLowerCase() !== "content-length");
        headersMutated = true;
      }

      const params: Record<string, unknown> = { requestId };
      if (urlMutated) params.url = curUrl;
      if (methodMutated) params.method = curMethod;
      if (headersMutated) params.headers = curHeaders;
      if (postDataMutated && curPostData !== undefined) {
        params.postData = utf8ToBase64(curPostData);
      }

      const netEntry = networkId ? network.get(tabId)?.get(networkId) : undefined;
      if (netEntry) {
        if (urlMutated) netEntry.url = curUrl;
        if (methodMutated) netEntry.method = curMethod;
        if (headersMutated) netEntry.requestHeaders = headerEntriesToRecord(curHeaders);
        if (postDataMutated && curPostData !== undefined) {
          netEntry.postData = capBodyText(curPostData).value;
          netEntry.hasPostData = true;
        }
      }

      await chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", params);
      settle();
      return;
    }

    // Response stage
    if (p.responseErrorReason !== undefined) {
      await resumeSafe();
      return;
    }

    const statusCode = Number(p.responseStatusCode);
    const respHeaders: HeaderEntry[] = Array.isArray(p.responseHeaders)
      ? (p.responseHeaders as { name?: unknown; value?: unknown }[]).map((h) => ({
          name: String(h?.name ?? ""),
          value: String(h?.value ?? ""),
        }))
      : [];

    const matched = (interceptRules.get(tabId) ?? []).filter(
      (r) =>
        r.stage === "Response" &&
        matchUrlPattern(r.urlPattern, reqUrl) &&
        (!r.method || r.method.toUpperCase() === reqMethod) &&
        (r.statusFilter === undefined || r.statusFilter === statusCode),
    );

    if (matched.length === 0) {
      await resumeSafe();
      return;
    }

    const cur = networkId ? network.get(tabId)?.get(networkId) : undefined;
    const hasNoBodyStatus = statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200);
    let bodyRes: { body?: string; base64Encoded?: boolean } | undefined;
    if (!hasNoBodyStatus) {
      bodyRes = (await chrome.debugger
        .sendCommand({ tabId }, "Fetch.getResponseBody", { requestId })
        .catch(() => undefined)) as { body?: string; base64Encoded?: boolean } | undefined;
    }

    const isText = isTextContentType(respHeaders);
    let decodedText: string | undefined;
    if (bodyRes && typeof bodyRes.body === "string") {
      if (isText) {
        decodedText = bodyRes.base64Encoded ? base64ToUtf8(bodyRes.body) : bodyRes.body;
        if (cur) {
          const capped = capBodyText(decodedText);
          cur.body = capped.value;
          cur.bodyBase64 = false;
          cur.bodyBytes = decodedText.length;
          cur.bodyTruncated = capped.truncated;
          cur.bodyError = undefined;
        }
      } else if (cur) {
        cur.bodyBase64 = true;
        cur.bodyBytes = Math.round(bodyRes.body.length * 0.75);
        cur.bodyError = undefined;
      }
    }

    let finalStatus = statusCode;
    let finalPhrase = typeof p.responseStatusText === "string" ? p.responseStatusText : "";
    let finalHeaders = respHeaders;
    let finalText = decodedText;
    let mutated = false;
    let bodyMutated = false;

    for (const r of matched) {
      r.hits++;
      if (r.overrideStatus !== undefined && r.overrideStatus !== finalStatus) {
        finalStatus = r.overrideStatus;
        finalPhrase = r.overrideStatusText ?? STATUS_PHRASES[r.overrideStatus] ?? "OK";
        mutated = true;
      } else if (r.overrideStatusText !== undefined) {
        finalPhrase = r.overrideStatusText;
        mutated = true;
      }
      if (r.setHeaders || r.removeHeaders?.length) {
        finalHeaders = applyHeaderMutations(finalHeaders, r.setHeaders, r.removeHeaders);
        mutated = true;
      }
      if (r.overrideBody !== undefined) {
        finalText = r.overrideBody;
        bodyMutated = true;
        mutated = true;
      } else if (r.replaceBody?.length && finalText !== undefined) {
        const rep = applyBodyReplacements(finalText, r.replaceBody);
        if (rep.changed) {
          finalText = rep.body;
          bodyMutated = true;
          mutated = true;
        }
      }
    }

    if (!mutated) {
      await resumeSafe();
      return;
    }

    if (cur) {
      cur.status = finalStatus;
      if (finalPhrase) cur.statusText = finalPhrase;
      cur.responseHeaders = headerEntriesToRecord(finalHeaders);
      if (bodyMutated && finalText !== undefined) {
        const capped = capBodyText(finalText);
        cur.body = capped.value;
        cur.bodyBase64 = false;
        cur.bodyBytes = finalText.length;
        cur.bodyTruncated = capped.truncated;
        cur.bodyError = undefined;
      }
    }

    const canFulfillWithBody =
      (bodyMutated && finalText !== undefined) ||
      (!hasNoBodyStatus && bodyRes !== undefined && typeof bodyRes.body === "string");

    if (canFulfillWithBody) {
      const strip = new Set(["content-encoding", "content-length", "transfer-encoding"]);
      const fulfillHeaders = finalHeaders.filter((h) => !strip.has(h.name.toLowerCase()));
      const finalBodyB64 =
        bodyMutated && finalText !== undefined
          ? utf8ToBase64(finalText)
          : bodyRes!.base64Encoded
            ? bodyRes!.body!
            : utf8ToBase64(bodyRes!.body!);
      const phrase = finalPhrase || STATUS_PHRASES[finalStatus] || "";
      await chrome.debugger.sendCommand({ tabId }, "Fetch.fulfillRequest", {
        requestId,
        responseCode: finalStatus,
        ...(phrase ? { responsePhrase: phrase } : {}),
        responseHeaders: fulfillHeaders,
        body: finalBodyB64,
      });
      settle();
      return;
    }

    await chrome.debugger.sendCommand({ tabId }, "Fetch.continueResponse", {
      requestId,
      responseCode: finalStatus,
      ...(finalPhrase ? { responsePhrase: finalPhrase } : {}),
      responseHeaders: finalHeaders,
    });
    settle();
  } catch {
    await resumeSafe();
  }
}

export async function addInterceptRule(tabId: number, input: InterceptRuleInput): Promise<InterceptRule> {
  for (const r of input.replaceBody ?? []) {
    if (r.regex) {
      try {
        new RegExp(r.find, "g");
      } catch (e) {
        throw new Error(`regex inválida "${r.find}": ${(e as Error).message}`);
      }
    }
  }
  const rule: InterceptRule = {
    ...input,
    id: `rule_${++ruleSeq}`,
    urlPattern: normalizeUrlPattern(input.urlPattern),
    hits: 0,
  };
  const list = interceptRules.get(tabId) ?? [];
  list.push(rule);
  interceptRules.set(tabId, list);
  await syncFetch(tabId);
  return { ...rule };
}

export function listInterceptRules(tabId: number): InterceptRule[] {
  return (interceptRules.get(tabId) ?? []).map((r) => ({ ...r }));
}

export async function removeInterceptRule(tabId: number, ruleId: string): Promise<boolean> {
  const list = interceptRules.get(tabId);
  if (!list) return false;
  const idx = list.findIndex((r) => r.id === ruleId);
  if (idx < 0) return false;
  list.splice(idx, 1);
  if (list.length === 0) interceptRules.delete(tabId);
  await syncFetch(tabId);
  return true;
}

export async function clearInterceptRules(tabId: number): Promise<number> {
  const list = interceptRules.get(tabId);
  const count = list?.length ?? 0;
  interceptRules.delete(tabId);
  await syncFetch(tabId);
  return count;
}

export async function withOneShotRequestHeaders<T>(
  tabId: number,
  opts: { url: string; method?: string; setHeaders: Record<string, string>; removeHeaders?: string[] },
  fn: () => Promise<T>,
): Promise<T> {
  const cleanUrl = opts.url.replace(/#.*$/, "");
  const entry: OneShotOverride = {
    id: `oneshot_${++ruleSeq}`,
    url: cleanUrl,
    urlPattern: cleanUrl,
    method: opts.method?.toUpperCase(),
    setHeaders: opts.setHeaders,
    removeHeaders: opts.removeHeaders,
  };
  const list = oneShotOverrides.get(tabId) ?? [];
  list.push(entry);
  oneShotOverrides.set(tabId, list);
  await syncFetch(tabId);
  try {
    return await fn();
  } finally {
    const cur = oneShotOverrides.get(tabId);
    if (cur) {
      const idx = cur.indexOf(entry);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) oneShotOverrides.delete(tabId);
    }
    await syncFetch(tabId).catch(() => {});
  }
}
