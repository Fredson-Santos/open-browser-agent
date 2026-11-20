// Implementação das ferramentas MCP. Cada uma recebe os argumentos do agente e
// devolve um CallToolResult do MCP.

import * as cdp from "./cdp";
import * as gif from "./gif";
import * as input from "./input";
import * as overlay from "./overlay";
import * as page from "./page";
import * as permissions from "./permissions";
import * as sessions from "./sessions";
import { K, type LogEntry, getSession } from "./store";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ArtexExchange = {
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
};

export type ToolResult = { content: Content[]; isError?: boolean; _artex_exchanges?: ArtexExchange[] };

const ARTEX_MAX_BODY = 256 * 1024;
const ARTEX_HEADER_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function sanitizeArtexHeaders(headers?: Record<string, string> | [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const pairs: [string, string][] = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [rawKey, rawVal] of pairs) {
    const key = String(rawKey).trim().toLowerCase();
    if (!key || key.startsWith(":") || !ARTEX_HEADER_RE.test(key)) continue;
    const sep = key === "cookie" || key === "set-cookie" ? "; " : ", ";
    const val = String(rawVal ?? "")
      .replace(/\x00/g, "")
      .replace(/\r?\n|\r/g, sep);
    out[key] = val;
  }
  return out;
}

function entryToArtexExchange(entry: cdp.NetworkEntry, bodyOverride?: string): ArtexExchange | null {
  if (!/^https?:\/\//i.test(entry.url) || typeof entry.status !== "number" || entry.status <= 0) {
    return null;
  }
  const respBody =
    bodyOverride !== undefined
      ? bodyOverride
      : entry.bodyBase64
        ? ""
        : (entry.body ?? "");
  return {
    method: entry.method.toUpperCase(),
    url: entry.url,
    status: entry.status,
    requestHeaders: sanitizeArtexHeaders(entry.requestHeaders),
    requestBody: (entry.postData ?? "").slice(0, ARTEX_MAX_BODY),
    responseHeaders: sanitizeArtexHeaders(entry.responseHeaders),
    responseBody: respBody.slice(0, ARTEX_MAX_BODY),
  };
}

/** `call` identifica a chamada para o host poder cancelá-la (ver abortCall). */
export type Ctx = { session: string; client: string; stealth?: boolean; call?: string; signal?: AbortSignal };
type Args = Record<string, unknown>;
type Handler = (ctx: Ctx, args: Args) => Promise<ToolResult>;

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describe(tabs: chrome.tabs.Tab[]): string {
  if (tabs.length === 0) return "Nenhuma aba no grupo desta sessão. Use tabs_create ou tabs_context com create_if_empty=true.";
  return JSON.stringify(
    tabs.map((t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active })),
    null,
    2,
  );
}

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return "https://" + url;
}

/** Espera a aba terminar de carregar (ou desiste após timeout, sem erro). */
function waitForLoad(tabId: number, timeoutMs = 30_000): { done: Promise<boolean> } {
  let listener: (id: number, info: { status?: string }) => void;
  const done = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return { done };
}

/** Abas em segundo plano não renderizam: screenshot e cliques exigem a aba ativa. */
async function activate(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.active) return;
  await chrome.tabs.update(tab.id!, { active: true });
  await sleep(150);
}

// ---------------------------------------------------------------- screenshot

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Captura a viewport e redimensiona para pixels CSS, para que as coordenadas
 * da imagem sejam exatamente as usadas pela ação `computer`.
 */
async function capture(tab: chrome.tabs.Tab, format: "jpeg" | "png", stealth = false) {
  const tabId = tab.id!;
  if (cdp.isRestricted(tab.url)) throw new Error(`o navegador não permite capturar ${tab.url}.`);
  const dialog = cdp.pendingDialog(tabId);
  if (dialog) throw cdp.dialogError(dialog);
  await activate(tab);
  const take = () =>
    cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: 80 } : {}),
    });
  const { data } = stealth ? await take() : await overlay.hiddenDuring(tabId, take);
  const { result } = await cdp.send<{ result: { value: number } }>(tabId, "Runtime.evaluate", {
    expression: "window.devicePixelRatio",
    returnByValue: true,
  });
  const dpr = result?.value || 1;
  const mime = `image/${format}`;
  const bmp = await createImageBitmap(new Blob([b64ToBytes(data)], { type: mime }));
  const width = Math.round(bmp.width / dpr);
  const height = Math.round(bmp.height / dpr);
  if (Math.abs(dpr - 1) < 0.01) return { data, mime, width, height };

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: mime, quality: 0.8 });
  return { data: bytesToB64(new Uint8Array(await blob.arrayBuffer())), mime, width, height };
}

async function screenshotResult(tab: chrome.tabs.Tab, format: "jpeg" | "png", prefix = "", stealth = false): Promise<ToolResult> {
  const shot = await capture(tab, format, stealth);
  return {
    content: [
      { type: "image", data: shot.data, mimeType: shot.mime },
      {
        type: "text",
        text: `${prefix}Screenshot da aba ${tab.id} (${shot.width}x${shot.height}, pixels = coordenadas para computer): ${tab.url}`,
      },
    ],
  };
}

// ---------------------------------------------------------------- wait_for

// Conexões longas não contam para "rede ociosa".
const LONG_LIVED = new Set(["WebSocket", "EventSource", "Ping"]);

function pendingRequests(tabId: number): number {
  const now = Date.now();
  // Pedidos abertos há mais de 15s são long polling/streams: ignorados.
  return cdp.networkEntries(tabId).filter((e) => !e.done && !LONG_LIVED.has(e.type ?? "") && now - e.t < 15_000).length;
}

/**
 * Espera uma condição da página em vez de um tempo fixo: texto aparecer
 * (text), texto sumir (text_gone, ex.: "Carregando") e/ou rede ociosa por
 * 500 ms (network_idle). Sem condição, espera a rede ficar ociosa.
 */
async function waitFor(tabId: number, args: Args): Promise<{ ok: boolean; msg: string }> {
  const want = typeof args.text === "string" && args.text.trim() ? args.text.trim() : undefined;
  const gone = typeof args.text_gone === "string" && args.text_gone.trim() ? args.text_gone.trim() : undefined;
  const idle = args.network_idle === true || (!want && !gone);
  const timeout = Math.min(Math.max(Number(args.timeout ?? 15), 0.5), 60) * 1000;
  if (idle) await cdp.track(tabId);

  const start = Date.now();
  let idleSince = 0;
  const met = { text: !want, gone: !gone, idle: !idle };
  while (true) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      try {
        if (want) met.text = await page.call<boolean>(tabId, "hasText", want);
        if (gone) met.gone = !(await page.call<boolean>(tabId, "hasText", gone));
      } catch {
        /* página trocando: tenta de novo */
      }
    }
    if (idle) {
      if (pendingRequests(tabId) === 0) {
        idleSince ||= Date.now();
        met.idle = Date.now() - idleSince >= 500;
      } else {
        idleSince = 0;
        met.idle = false;
      }
    }
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    if (met.text && met.gone && met.idle) {
      const what = [want && `"${want}" apareceu`, gone && `"${gone}" sumiu`, idle && "rede ociosa"].filter(Boolean).join(", ");
      return { ok: true, msg: `Pronto em ${secs}s: ${what}.` };
    }
    if (Date.now() - start >= timeout) {
      const missing = [!met.text && `"${want}" não apareceu`, !met.gone && `"${gone}" continua na página`, !met.idle && `rede ainda ocupada (${pendingRequests(tabId)} pedido(s))`].filter(Boolean).join("; ");
      return { ok: false, msg: `Tempo esgotado após ${secs}s: ${missing}. Confira a página com screenshot ou get_page_text.` };
    }
    await sleep(250);
  }
}

// ---------------------------------------------------------------- computer

function coord(v: unknown, label = "coordinate"): [number, number] {
  if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [v[0], v[1]];
  }
  throw new Error(`${label} deve ser [x, y] em pixels do screenshot.`);
}

/** Resolve o alvo de uma ação: ref (preferido) ou coordinate. */
async function target(tabId: number, args: Args): Promise<{ x: number; y: number; note: string }> {
  if (typeof args.ref === "string" && args.ref) {
    const p = await page.call<page.Point>(tabId, "resolveRef", args.ref, true);
    let note = "";
    if (p.covered_by) note += ` (atenção: o ponto está coberto por ${p.covered_by})`;
    if (!p.in_viewport) note += " (atenção: o elemento continua fora da viewport)";
    return { x: p.x, y: p.y, note };
  }
  if (args.coordinate !== undefined) {
    const [x, y] = coord(args.coordinate);
    return { x, y, note: "" };
  }
  throw new Error("informe ref (de read_page/find) ou coordinate [x, y].");
}

const MOD_BITS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

function modifiers(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  return v.split("+").reduce((acc, m) => acc | (MOD_BITS[m.trim().toLowerCase()] ?? 0), 0);
}

// Último ponto de clique por aba (desenhado nos quadros do GIF).
const lastPoint = new Map<number, { x: number; y: number }>();

async function computer(ctx: Ctx, args: Args): Promise<ToolResult> {
  const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
  const tabId = tab.id!;
  const action = String(args.action ?? "");
  if (action !== "wait" && cdp.isRestricted(tab.url)) {
    throw new Error(`o navegador não permite automatizar ${tab.url}.`);
  }
  const open = cdp.pendingDialog(tabId);
  if (open && action !== "wait") throw cdp.dialogError(open);
  if (action !== "wait") await activate(tab);

  // Um clique que abre alert/confirm deixa o comando CDP pendurado até alguém
  // responder ao diálogo: corre contra o evento de abertura e devolve na hora.
  const watcher = cdp.waitDialog(tabId);
  const children = NAV_ACTIONS.has(action) ? await openedBy(tabId) : new Set<number>();
  try {
    const raced = await Promise.race([
      computerAction(tab, action, args, ctx.stealth === true),
      watcher.promise.then((d) => ({ dialog: d })),
    ]);
    if ("dialog" in raced) {
      const d = raced.dialog;
      return text(`${action} executado. A página abriu um diálogo ${d.type}: "${d.message}". ` +
        `Ela fica bloqueada até você responder com handle_dialog (accept=true/false${d.type === "prompt" ? ", prompt_text" : ""}).`);
    }
    if (NAV_ACTIONS.has(action)) {
      const note = await navigationNote(ctx, tabId, tab.url, children);
      if (note) raced.content.push({ type: "text", text: note });
    }
    return raced;
  } finally {
    watcher.cancel();
  }
}

// Ações que podem levar a outra página (link, submit, Enter…).
const NAV_ACTIONS = new Set(["left_click", "middle_click", "double_click", "key", "type"]);

async function openedBy(tabId: number): Promise<Set<number>> {
  const all = await chrome.tabs.query({}).catch(() => []);
  return new Set(all.filter((t) => t.openerTabId === tabId).map((t) => t.id!));
}

/**
 * Conta ao agente se a ação mudou a URL (navegação ou pushState de SPA) ou
 * abriu abas (target=_blank); as abas novas entram no grupo da sessão.
 */
async function navigationNote(ctx: Ctx, tabId: number, before: string | undefined, children: Set<number>): Promise<string> {
  await sleep(200);
  const after = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!after) return "";
  const notes: string[] = [];
  if (after.url && after.url !== before) {
    notes.push(`A página mudou: ${after.url}${after.status === "loading" ? " (ainda carregando; use wait_for)" : ""}. Refs antigos podem ter expirado.`);
  } else if (after.status === "loading") {
    notes.push("A página começou a carregar; use wait_for antes de ler.");
  }
  for (const id of await openedBy(tabId)) {
    if (children.has(id)) continue;
    const child = await chrome.tabs.get(id).catch(() => undefined);
    if (!child || child.windowId !== after.windowId) {
      notes.push(`A ação abriu uma janela separada (tab_id ${id}), fora do grupo desta sessão.`);
      continue;
    }
    const t = await sessions.adoptTab(ctx.session, ctx.client, id).catch(() => undefined);
    if (t) notes.push(`Abriu uma aba nova no grupo: tab_id ${t.id} (${t.pendingUrl || t.url}).`);
  }
  return notes.join("\n");
}

const runAt = (stealth: boolean, tabId: number, x: number, y: number, fn: () => Promise<unknown>, click = true) =>
  stealth ? fn() : overlay.pointAt(tabId, x, y, fn, click);

async function computerAction(tab: chrome.tabs.Tab, action: string, args: Args, stealth = false): Promise<ToolResult> {
  const tabId = tab.id!;
  switch (action) {
    case "screenshot":
      return screenshotResult(tab, "jpeg", "", stealth);

    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const t = await target(tabId, args);
      const button: input.Button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      const count = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      lastPoint.set(tabId, t);
      await runAt(stealth, tabId, t.x, t.y, () => input.click(tabId, t.x, t.y, button, count, modifiers(args.modifiers)));
      return text(`${action} em (${t.x}, ${t.y})${t.note}`);
    }

    case "hover": {
      const t = await target(tabId, args);
      lastPoint.set(tabId, t);
      await runAt(stealth, tabId, t.x, t.y, () => input.move(tabId, t.x, t.y), false);
      return text(`Mouse sobre (${t.x}, ${t.y})${t.note}`);
    }

    case "left_click_drag": {
      const from = coord(args.start_coordinate, "start_coordinate");
      const to = coord(args.coordinate);
      await runAt(stealth, tabId, from[0], from[1], () => input.drag(tabId, from, to), false);
      if (!stealth) await overlay.pointAt(tabId, to[0], to[1], async () => {}, false);
      return text(`Arrastou de (${from}) para (${to})`);
    }

    case "type": {
      const value = String(args.text ?? "");
      if (!value) throw new Error("text é obrigatório para action=type.");
      let where = "no elemento focado";
      if (args.ref || args.coordinate) {
        const t = await target(tabId, args);
        lastPoint.set(tabId, t);
        await runAt(stealth, tabId, t.x, t.y, () => input.click(tabId, t.x, t.y));
        where = `em (${t.x}, ${t.y})${t.note}`;
      }
      await input.insertText(tabId, value);
      return text(`Digitou ${value.length} caractere(s) ${where}`);
    }

    case "key": {
      const spec = String(args.text ?? "");
      const repeat = typeof args.repeat === "number" ? args.repeat : 1;
      await input.keys(tabId, spec, repeat);
      return text(`Teclas: ${spec}${repeat > 1 ? ` ×${repeat}` : ""}`);
    }

    case "scroll": {
      const vp = await page.call<page.Viewport>(tabId, "viewport");
      let x = vp.width / 2;
      let y = vp.height / 2;
      if (args.ref || args.coordinate) ({ x, y } = await target(tabId, args));
      const dir = String(args.scroll_direction ?? "down");
      const amount = typeof args.scroll_amount === "number" ? args.scroll_amount : 3;
      const step = amount * 100;
      const [dx, dy] = dir === "up" ? [0, -step] : dir === "left" ? [-step, 0] : dir === "right" ? [step, 0] : [0, step];
      await input.wheel(tabId, x, y, dx, dy);
      await sleep(300);
      const after = await page.call<page.Viewport>(tabId, "viewport");
      return text(`Scroll ${dir} ×${amount}. Posição: ${after.scrollX},${after.scrollY}`);
    }

    case "scroll_to": {
      if (typeof args.ref !== "string") throw new Error("ref é obrigatório para action=scroll_to.");
      const p = await page.call<page.Point>(tabId, "resolveRef", args.ref, true);
      return text(`${args.ref} visível em (${p.x}, ${p.y})`);
    }

    case "wait": {
      const secs = Math.min(Math.max(Number(args.duration ?? 1), 0), 30);
      await sleep(secs * 1000);
      return text(`Esperou ${secs}s`);
    }

    default:
      throw new Error(`action desconhecida: "${action}"`);
  }
}

// ---------------------------------------------------------------- registro

const FORBIDDEN_FETCH_HEADERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
  "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive",
  "origin", "referer", "te", "trailer", "transfer-encoding", "upgrade", "user-agent", "via",
]);

function isForbiddenFetchHeader(name: string): boolean {
  const low = name.toLowerCase();
  return FORBIDDEN_FETCH_HEADERS.has(low) || low.startsWith("sec-") || low.startsWith("proxy-");
}

function formatHeaders(headers?: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    for (const part of String(v).split(/\r?\n/)) {
      lines.push(`${k}: ${part}`);
    }
  }
  return lines;
}

const handlers: Record<string, Handler> = {
  async tabs_context(ctx, args) {
    let tabs = await sessions.listTabs(ctx.session, ctx.client);
    if (tabs.length === 0 && args.create_if_empty === true) {
      const created = await sessions.createTab(ctx.session, ctx.client, undefined, ctx.stealth === true);
      if (ctx.stealth && created.id !== undefined) cdp.setStealthTab(created.id, true);
      tabs = await sessions.listTabs(ctx.session, ctx.client);
    }
    return text(describe(tabs));
  },

  async tabs_create(ctx, args) {
    const url = typeof args.url === "string" && args.url ? normalizeUrl(args.url) : undefined;
    // Cria vazia e só então navega, para o listener de carregamento já estar ativo.
    const tab = await sessions.createTab(ctx.session, ctx.client, undefined, ctx.stealth === true);
    if (ctx.stealth) cdp.setStealthTab(tab.id!, true);
    await cdp.track(tab.id!); // console/rede desde o primeiro carregamento
    if (url) {
      const { done } = waitForLoad(tab.id!);
      await chrome.tabs.update(tab.id!, { url });
      await done;
    }
    const fresh = await chrome.tabs.get(tab.id!);
    return text(`Aba criada.\n${describe([fresh])}`);
  },

  async tabs_close(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    await chrome.tabs.remove(tab.id!);
    return text(`Aba ${tab.id} fechada.`);
  },

  async navigate(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    const dest = String(args.url ?? "").trim();
    if (!dest) throw new Error("url é obrigatória.");
    if (ctx.stealth) cdp.setStealthTab(tabId, true);
    if (!cdp.isRestricted(tab.url)) await cdp.track(tabId);

    const { done } = waitForLoad(tabId);
    switch (dest.toLowerCase()) {
      case "back":
        await chrome.tabs.goBack(tabId);
        break;
      case "forward":
        await chrome.tabs.goForward(tabId);
        break;
      case "reload":
        await chrome.tabs.reload(tabId);
        break;
      default:
        await chrome.tabs.update(tabId, { url: normalizeUrl(dest) });
    }
    const loaded = await done;
    let note = loaded ? "" : "\n(aviso: o carregamento não terminou em 30s)";
    if (args.wait_for !== undefined) note += `\n${(await waitFor(tabId, args.wait_for === true ? {} : typeof args.wait_for === "string" ? { text: args.wait_for } : (args.wait_for as Args))).msg}`;
    const fresh = await chrome.tabs.get(tabId);
    return text(`Navegou para ${fresh.url}\nTítulo: ${fresh.title}${note}`);
  },

  async screenshot(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    return screenshotResult(tab, args.format === "png" ? "png" : "jpeg", "", ctx.stealth === true);
  },

  async read_page(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const out = await page.call<string>(tab.id!, "readPage", {
      filter: args.filter,
      max_depth: typeof args.max_depth === "number" ? args.max_depth : undefined,
      ref_id: typeof args.ref_id === "string" ? args.ref_id : undefined,
      ...(ctx.stealth ? { include_secrets: true, include_hidden: true } : {}),
    });
    return text(out);
  },

  async find(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const query = String(args.query ?? "");
    const limit = typeof args.limit === "number" ? args.limit : 20;
    return text(await page.call<string>(tab.id!, "find", query, limit, ctx.stealth === true));
  },

  async get_page_text(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    return text(await page.call<string>(tab.id!, "pageText", {
      max_chars: typeof args.max_chars === "number" ? args.max_chars : undefined,
      offset: typeof args.offset === "number" ? args.offset : undefined,
      ref_id: typeof args.ref_id === "string" && args.ref_id ? args.ref_id : undefined,
    }));
  },

  async wait_for(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const r = await waitFor(tab.id!, args);
    return { ...text(r.msg), ...(r.ok ? {} : { isError: true }) };
  },

  async batch(ctx, args) {
    const steps = Array.isArray(args.actions) ? args.actions : [];
    if (steps.length === 0) throw new Error("actions é obrigatório: lista de {tool, args}.");
    if (steps.length > 30) throw new Error("no máximo 30 ações por batch.");
    const stopOnError = args.stop_on_error !== false;
    const content: Content[] = [];
    const collectedExchanges: ArtexExchange[] = [];
    let failed = 0;
    // Etapas rodam sem o id da chamada externa (cancelá-la cancela o batch inteiro pelo sinal).
    const inner: Ctx = { session: ctx.session, client: ctx.client, stealth: ctx.stealth, signal: ctx.signal };
    for (const [i, raw] of steps.entries()) {
      if (ctx.signal?.aborted) break;
      const step = (raw ?? {}) as { tool?: unknown; args?: unknown };
      const name = String(step.tool ?? "");
      const stepArgs = { ...((step.args as Args | undefined) ?? {}) };
      // tab_id do batch vale para as ações que não informam o seu.
      if (stepArgs.tab_id === undefined && typeof args.tab_id === "number") stepArgs.tab_id = args.tab_id;
      let r: ToolResult;
      if (name === "batch") r = errorResult("batch não pode conter outro batch.");
      else if (!handlers[name]) r = errorResult(`ferramenta desconhecida: ${name}`);
      else r = await execute(handlers[name], name, inner, stepArgs);
      if (r._artex_exchanges?.length) {
        collectedExchanges.push(...r._artex_exchanges);
      }
      const err = r.isError ? r.content.find((c) => c.type === "text")?.text : undefined;
      await log({ t: Date.now(), client: ctx.client, tool: `batch › ${name}`, detail: summarize(name, stepArgs), ok: !r.isError, error: err?.slice(0, 200) });
      content.push({ type: "text", text: `── ${i + 1}. ${name} ${summarize(name, stepArgs)}${r.isError ? " ✗" : ""}` });
      content.push(...r.content);
      if (r.isError) {
        failed++;
        if (stopOnError) {
          if (i + 1 < steps.length) content.push({ type: "text", text: `(parou no erro; ${steps.length - i - 1} ação(ões) não executada(s))` });
          break;
        }
      }
    }
    return {
      content,
      ...(failed && stopOnError ? { isError: true } : {}),
      ...(collectedExchanges.length > 0 ? { _artex_exchanges: collectedExchanges } : {}),
    };
  },

  computer,

  async form_input(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    if (typeof args.ref !== "string") throw new Error("ref é obrigatório (de read_page/find).");
    if (args.value === undefined) throw new Error("value é obrigatório.");
    return text(await page.call<string>(tab.id!, "formInput", args.ref, args.value, ctx.stealth === true));
  },

  async handle_dialog(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const d = cdp.pendingDialog(tab.id!);
    if (!d) return text("Não há diálogo aberto nesta aba.");
    const accept = args.accept !== false;
    await cdp.send(tab.id!, "Page.handleJavaScriptDialog", {
      accept,
      ...(typeof args.prompt_text === "string" ? { promptText: args.prompt_text } : {}),
    });
    return text(`Diálogo ${d.type} "${d.message}" ${accept ? "aceito" : "recusado"}.`);
  },

  async read_console(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    await cdp.track(tabId);
    let list = cdp.consoleEntries(tabId);
    if (args.only_errors === true) list = list.filter((e) => e.level === "error" || e.level === "exception");
    if (typeof args.pattern === "string" && args.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, "i");
      } catch {
        throw new Error(`pattern inválido: ${args.pattern}`);
      }
      list = list.filter((e) => re.test(e.text) || re.test(e.url ?? ""));
    }
    const limit = typeof args.limit === "number" ? args.limit : 100;
    const shown = list.slice(-limit);
    if (args.clear === true) cdp.clearConsole(tabId);
    if (shown.length === 0) {
      return text("Nenhuma mensagem de console capturada. A captura começa quando o agente abre/navega a aba; recarregue (navigate reload) para pegar as do carregamento.");
    }
    const t0 = shown[0].t;
    const lines = shown.map((e) => `[+${((e.t - t0) / 1000).toFixed(1)}s] ${e.level.toUpperCase()} ${e.text.length > 1000 ? e.text.slice(0, 999) + "…" : e.text}${e.url ? `  (${e.url})` : ""}`);
    return text(`${shown.length} de ${list.length} mensagem(ns):\n${lines.join("\n")}`);
  },

  async read_network(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    await cdp.track(tabId);
    if (typeof args.request_id === "string" && args.request_id) {
      const entry = cdp.networkEntries(tabId).find((e) => e.id === args.request_id);
      if (!entry) throw new Error(`requisição ${args.request_id} não encontrada.`);
      const maxBody = Math.min(
        Math.max(typeof args.max_body_chars === "number" ? args.max_body_chars : 20_000, 1_000),
        256_000,
      );

      if (entry.hasPostData && entry.postData === undefined) {
        const post = await cdp
          .send<{ postData?: string }>(tabId, "Network.getRequestPostData", { requestId: args.request_id })
          .catch(() => undefined);
        if (typeof post?.postData === "string") {
          entry.postData = post.postData.slice(0, 256 * 1024);
        }
      }

      let bodyText = entry.body;
      let bodyBase64 = entry.bodyBase64;
      let bodyBytes = entry.bodyBytes;
      let bodyTruncated = entry.bodyTruncated ?? false;
      let bodyErr = entry.bodyError;

      if (bodyText === undefined && bodyBase64 === undefined) {
        try {
          const res = await cdp.send<{ body: string; base64Encoded: boolean }>(
            tabId,
            "Network.getResponseBody",
            { requestId: args.request_id },
          );
          if (res.base64Encoded) {
            bodyBase64 = true;
            bodyBytes = Math.round(res.body.length * 0.75);
          } else {
            bodyBase64 = false;
            bodyBytes = res.body.length;
            if (res.body.length > 256 * 1024) {
              bodyText = res.body.slice(0, 256 * 1024);
              bodyTruncated = true;
            } else {
              bodyText = res.body;
            }
          }
          entry.body = bodyText;
          entry.bodyBase64 = bodyBase64;
          entry.bodyBytes = bodyBytes;
          entry.bodyTruncated = bodyTruncated;
        } catch (e) {
          bodyErr = (e as Error)?.message ?? String(e);
        }
      }

      const out: string[] = [];
      out.push("=== REQUEST ===");
      out.push(`${entry.method} ${entry.url}`);
      const reqHeaders = formatHeaders(entry.requestHeaders);
      out.push(...(reqHeaders.length ? reqHeaders : ["(nenhum header capturado)"]));
      if (entry.postData !== undefined) {
        out.push("");
        out.push(entry.postData.slice(0, maxBody));
        if (entry.postData.length > maxBody) {
          out.push(`\n(request body truncado em ${maxBody} caracteres de ${entry.postData.length})`);
        }
      } else if (entry.hasPostData) {
        out.push("");
        out.push("(request body indisponível no buffer CDP)");
      }

      if (entry.redirects?.length) {
        out.push("");
        out.push("=== REDIRECTS ===");
        for (const [idx, hop] of entry.redirects.entries()) {
          out.push(`-- Hop ${idx + 1}: ${hop.status}${hop.statusText ? ` ${hop.statusText}` : ""} ${hop.url}`);
          const hopHeaders = formatHeaders(hop.responseHeaders);
          out.push(...(hopHeaders.length ? hopHeaders : ["(sem headers)"]));
        }
      }

      out.push("");
      out.push("=== RESPONSE ===");
      if (entry.error) {
        out.push(`ERRO: ${entry.error}`);
      } else if (entry.status !== undefined) {
        const proto = entry.protocol ? entry.protocol.toUpperCase() : "HTTP";
        out.push(
          `${proto} ${entry.status}${entry.statusText ? ` ${entry.statusText}` : ""}${entry.mimeType ? ` (${entry.mimeType})` : ""}`,
        );
      } else {
        out.push("(pendente)");
      }
      const respHeaders = formatHeaders(entry.responseHeaders);
      out.push(...(respHeaders.length ? respHeaders : ["(nenhum header capturado)"]));
      out.push("");
      if (bodyBase64) {
        out.push(
          `(corpo binário: ${Math.max(1, Math.round((bodyBytes ?? 0) / 1024))} KB, ${entry.mimeType ?? "unknown"})`,
        );
      } else if (typeof bodyText === "string") {
        if (bodyText.length === 0) {
          out.push("(sem corpo)");
        } else {
          out.push(bodyText.slice(0, maxBody));
          if (bodyText.length > maxBody || bodyTruncated) {
            const total = bodyBytes ?? bodyText.length;
            out.push(`\n(response body truncado em ${Math.min(maxBody, bodyText.length)} caracteres de ${total})`);
          }
        }
      } else {
        out.push(`(corpo indisponível: ${bodyErr ?? "buffer CDP descartado ou sem corpo"})`);
      }

      return {
        ...text(out.join("\n")),
        ...(args.artex_ingest === true
          ? (() => {
              const ex = entryToArtexExchange(entry, bodyBase64 ? "" : (bodyText ?? ""));
              return { _artex_exchanges: ex ? [ex] : [] };
            })()
          : {}),
      };
    }
    let list = cdp.networkEntries(tabId);
    if (typeof args.url_pattern === "string" && args.url_pattern) list = list.filter((e) => e.url.includes(args.url_pattern as string));
    if (args.only_errors === true) list = list.filter((e) => e.error || (e.status ?? 0) >= 400);
    if (args.include_static !== true) list = list.filter((e) => !["Image", "Font", "Stylesheet", "Media"].includes(e.type ?? ""));
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const shown = list.slice(-limit);
    let artexExchanges: ArtexExchange[] | undefined;
    if (args.artex_ingest === true) {
      const candidates = shown.slice(-50);
      let fetches = 0;
      artexExchanges = [];
      for (const e of candidates) {
        if (e.body === undefined && !e.bodyBase64 && !e.error && fetches < 10 && /^https?:\/\//i.test(e.url)) {
          fetches++;
          try {
            const res = await cdp.send<{ body: string; base64Encoded: boolean }>(
              tabId,
              "Network.getResponseBody",
              { requestId: e.id },
            );
            if (res.base64Encoded) {
              e.bodyBase64 = true;
            } else if (typeof res.body === "string") {
              e.bodyBase64 = false;
              e.body = res.body.slice(0, ARTEX_MAX_BODY);
            }
          } catch {
            /* fallback silencioso quando buffer CDP foi descartado */
          }
        }
        const ex = entryToArtexExchange(e);
        if (ex) artexExchanges.push(ex);
      }
    }
    if (args.clear === true) cdp.clearNetwork(tabId);
    if (shown.length === 0) {
      return {
        ...text("Nenhuma requisição capturada (com esses filtros). A captura começa quando o agente abre/navega a aba."),
        ...(artexExchanges ? { _artex_exchanges: artexExchanges } : {}),
      };
    }
    const lines = shown.map((e) => {
      const status = e.error ? `ERRO ${e.error}` : e.status ? `${e.status}` : e.done ? "?" : "pendente";
      const size = e.size !== undefined ? ` ${Math.max(1, Math.round(e.size / 1024))}KB` : "";
      const url = e.url.length > 160 ? e.url.slice(0, 159) + "…" : e.url;
      return `${e.method} ${status} ${e.type ?? ""}${size} ${url}  [id ${e.id}]`;
    });
    return {
      ...text(`${shown.length} de ${list.length} requisição(ões) (use request_id para ver a troca HTTP completa: request/response headers e body):\n${lines.join("\n")}`),
      ...(artexExchanges ? { _artex_exchanges: artexExchanges } : {}),
    };
  },

  async file_upload(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    const paths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean) : [];
    if (typeof args.ref !== "string" || paths.length === 0) throw new Error("ref e paths (lista de caminhos absolutos) são obrigatórios.");
    const mark = await page.call<{ token: string; multiple: boolean }>(tabId, "markUpload", args.ref);
    if (paths.length > 1 && !mark.multiple) throw new Error("este campo aceita só um arquivo.");
    await permissions.checkUpload(ctx.client, tab.url, paths, ctx.stealth === true);
    // Localiza o input no mundo principal (inclusive em iframes de mesma origem) pelo atributo marcado.
    const { result } = await cdp.send<{ result: { objectId?: string } }>(tabId, "Runtime.evaluate", {
      expression: `(() => { const sel = '[data-oba-upload="${mark.token}"]';
        const find = (doc) => { const el = doc.querySelector(sel); if (el) return el;
          for (const f of doc.querySelectorAll("iframe")) { try { const r = find(f.contentDocument); if (r) return r; } catch {} } return null; };
        return find(document); })()`,
    });
    if (!result.objectId) throw new Error("não foi possível localizar o campo de arquivo na página.");
    try {
      await cdp.send(tabId, "DOM.setFileInputFiles", { files: paths, objectId: result.objectId });
    } catch (e) {
      throw new Error(`falha ao anexar: ${(e as Error).message}. Confira se os caminhos existem e são absolutos.`);
    }
    return text(`${paths.length} arquivo(s) anexado(s) em ${args.ref}: ${paths.map((p) => p.split(/[\\/]/).pop()).join(", ")}`);
  },

  async gif_creator(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    switch (args.action) {
      case "start": {
        gif.start(tabId);
        try {
          const shot = await capture(tab, "jpeg", ctx.stealth === true);
          gif.addFrame(tabId, shot, "início");
        } catch {
          /* página interna: começa no próximo quadro */
        }
        return text("Gravando. Cada ação (cliques, digitação, navegação, scroll) vira um quadro. Use action=stop e depois export.");
      }
      case "stop":
        gif.stop(tabId);
        return text(`Gravação parada com ${gif.frameCount(tabId)} quadro(s). Use action=export para salvar.`);
      case "export": {
        gif.stop(tabId);
        const out = await gif.exportGif(tabId, typeof args.filename === "string" ? args.filename : undefined);
        return text(`GIF salvo: ${out.path} (${out.frames} quadros, ${out.kb} KB).`);
      }
      case "clear":
        gif.stop(tabId);
        gif.clear(tabId);
        return text("Quadros descartados.");
      default:
        throw new Error('action deve ser "start", "stop", "export" ou "clear".');
    }
  },

  async javascript(ctx, args) {
    await permissions.checkJavascript(ctx.stealth === true);
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    const d = cdp.pendingDialog(tabId);
    if (d) throw cdp.dialogError(d);
    const code = String(args.code ?? "");
    if (!code.trim()) throw new Error("code é obrigatório.");
    const r = await cdp.send<{ result: { value?: unknown; description?: string; type: string }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
      tabId,
      "Runtime.evaluate",
      { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true, timeout: 15_000, userGesture: true },
    );
    if (r.exceptionDetails) throw new Error(`exceção: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    const v = r.result.value;
    const out = v === undefined ? "(undefined — use return para devolver um valor)" : typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return text(out.length > 20_000 ? out.slice(0, 20_000) + "\n(truncado)" : out);
  },

  async cookies(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    const action = String(args.action ?? "").trim().toLowerCase();
    const defaultHttpUrl = () =>
      typeof args.url === "string" && args.url.trim()
        ? args.url.trim()
        : tab.url && /^https?:\/\//i.test(tab.url)
          ? tab.url
          : undefined;
    const urlArg = typeof args.url === "string" && args.url.trim() ? args.url.trim() : undefined;

    switch (action) {
      case "list": {
        const list = await cdp.getCookies(tabId, {
          all: args.all === true,
          urls: urlArg ? [urlArg] : undefined,
        });
        const filter = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
        const filtered = filter ? list.filter((c) => c.name.toLowerCase().includes(filter)) : list;
        if (filtered.length === 0) return text("Nenhum cookie encontrado.");
        const formatted = JSON.stringify(
          filtered.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
            session: c.session,
            expires: c.expires,
          })),
          null,
          2,
        );
        const body = formatted.length > 20_000 ? formatted.slice(0, 20_000) + "\n(truncado; filtre por name ou url)" : formatted;
        return text(`${filtered.length} cookie(s):\n${body}`);
      }

      case "get": {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new Error("name é obrigatório para action=get.");
        const list = await cdp.getCookies(tabId, {
          all: args.all === true,
          urls: urlArg ? [urlArg] : undefined,
        });
        const matches = list.filter((c) => c.name === name);
        if (matches.length === 0) return text(`Cookie "${name}" não encontrado.`);
        const formatted = JSON.stringify(matches, null, 2);
        return text(formatted.length > 20_000 ? formatted.slice(0, 20_000) + "\n(truncado)" : formatted);
      }

      case "set": {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new Error("name é obrigatório para action=set.");
        if (args.value === undefined || args.value === null) throw new Error("value é obrigatório para action=set.");
        const value = String(args.value);
        const domain = typeof args.domain === "string" && args.domain.trim() ? args.domain.trim() : undefined;
        let url = urlArg;
        if (!url && !domain) url = defaultHttpUrl();
        if (!url && !domain) throw new Error("informe url ou domain (a aba atual não está em http/https).");

        let sameSite: "Strict" | "Lax" | "None" | undefined;
        if (args.same_site !== undefined) {
          const raw = String(args.same_site).trim().toLowerCase();
          if (raw === "strict") sameSite = "Strict";
          else if (raw === "lax") sameSite = "Lax";
          else if (raw === "none") sameSite = "None";
          else throw new Error('same_site deve ser "Strict", "Lax" ou "None".');
        }

        const secure = typeof args.secure === "boolean" ? args.secure : sameSite === "None" ? true : undefined;
        const httpOnly = typeof args.http_only === "boolean" ? args.http_only : undefined;
        const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
        const expires = typeof args.expires === "number" && Number.isFinite(args.expires) ? args.expires : undefined;

        const ok = await cdp.setCookie(tabId, {
          name,
          value,
          url,
          domain,
          path,
          secure,
          httpOnly,
          sameSite,
          expires,
        });
        if (!ok) {
          throw new Error(`falha ao definir cookie "${name}"; verifique domain/url e flags secure/same_site.`);
        }
        const flags = [
          httpOnly ? "HttpOnly" : "",
          secure ? "Secure" : "",
          sameSite ? `SameSite=${sameSite}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        return text(`Cookie "${name}" definido para ${domain ?? url}${flags ? ` (${flags})` : ""}.`);
      }

      case "delete": {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new Error("name é obrigatório para action=delete.");
        const domain = typeof args.domain === "string" && args.domain.trim() ? args.domain.trim() : undefined;
        const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
        let url = urlArg;
        if (!url && !domain) url = defaultHttpUrl();
        if (!url && !domain) throw new Error("informe url ou domain (a aba atual não está em http/https).");
        await cdp.deleteCookies(tabId, { name, url, domain, path });
        return text(`Cookie "${name}" removido de ${domain ?? url}.`);
      }

      case "clear": {
        if (args.all === true) {
          await cdp.clearAllCookies(tabId);
          return text("Todos os cookies do navegador foram removidos.");
        }
        const targetUrl = defaultHttpUrl();
        const list = await cdp.getCookies(tabId, { urls: targetUrl ? [targetUrl] : undefined });
        for (const c of list) {
          await cdp.deleteCookies(tabId, { name: c.name, domain: c.domain, path: c.path });
        }
        return text(`${list.length} cookie(s) removido(s) de ${targetUrl ?? "aba atual"}.`);
      }

      default:
        throw new Error('action deve ser "list", "get", "set", "delete" ou "clear".');
    }
  },

  async storage(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    if (cdp.isRestricted(tab.url)) {
      throw new Error(`o navegador não permite ler/editar storage em ${tab.url}.`);
    }
    const d = cdp.pendingDialog(tabId);
    if (d) throw cdp.dialogError(d);

    const action = String(args.action ?? "").trim().toLowerCase() as cdp.StorageAction;
    if (!["list", "get", "set", "delete", "clear"].includes(action)) {
      throw new Error('action deve ser "list", "get", "set", "delete" ou "clear".');
    }
    const rawType = args.type === undefined ? (action === "list" ? "both" : "local") : String(args.type).trim().toLowerCase();
    if (!["local", "session", "both"].includes(rawType)) {
      throw new Error('type deve ser "local", "session" ou "both".');
    }
    const type = rawType as cdp.StorageScope;
    if (action === "set" && type === "both") {
      throw new Error('para action=set, informe type="local" ou "session".');
    }

    const key = typeof args.key === "string" ? args.key : undefined;
    if ((action === "get" || action === "set" || action === "delete") && !key) {
      throw new Error(`key é obrigatório para action=${action}.`);
    }
    if (action === "set" && (args.value === undefined || args.value === null)) {
      throw new Error("value é obrigatório para action=set.");
    }
    const value = args.value !== undefined && args.value !== null ? String(args.value) : undefined;
    const res = await cdp.execStorage(tabId, { action, type, key, value });
    const out = JSON.stringify(res, null, 2);
    return text(out.length > 20_000 ? out.slice(0, 20_000) + "\n(truncado)" : out);
  },

  async http_headers(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    const action = String(args.action ?? "").trim().toLowerCase();

    switch (action) {
      case "list": {
        const st = cdp.getTabHeaders(tabId);
        if (Object.keys(st.headers).length === 0 && st.userAgent === undefined) {
          return text("Nenhum header extra ou User-Agent customizado ativo nesta aba.");
        }
        return text(JSON.stringify(st, null, 2));
      }

      case "clear": {
        await cdp.clearTabHeaders(tabId);
        return text("Headers extras e User-Agent customizado removidos desta aba.");
      }

      case "set": {
        let headers: Record<string, string> | undefined;
        if (args.headers !== undefined) {
          if (typeof args.headers !== "object" || args.headers === null || Array.isArray(args.headers)) {
            throw new Error("headers deve ser um objeto {Nome: Valor}.");
          }
          headers = {};
          for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
            if (!k.trim() || k.startsWith(":")) continue;
            if (v === undefined || v === null) continue;
            headers[k] = String(v);
          }
        }
        const remove = Array.isArray(args.remove) ? args.remove.map(String).filter(Boolean) : undefined;
        const replace = args.replace === true;
        const userAgent = typeof args.user_agent === "string" ? args.user_agent : undefined;
        if (headers === undefined && !remove?.length && !replace && userAgent === undefined) {
          throw new Error("informe headers, remove, replace=true ou user_agent para action=set.");
        }
        const st = await cdp.setTabHeaders(tabId, { headers, remove, replace, userAgent });
        return text(`Configuração de headers aplicada na aba ${tabId}:\n${JSON.stringify(st, null, 2)}`);
      }

      default:
        throw new Error('action deve ser "set", "list" ou "clear".');
    }
  },

  async intercept_rules(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    const action = String(args.action ?? "").trim().toLowerCase();

    switch (action) {
      case "list": {
        const rules = cdp.listInterceptRules(tabId);
        if (rules.length === 0) return text("Nenhuma regra de interceptação ativa nesta aba.");
        return text(`${rules.length} regra(s) ativa(s):\n${JSON.stringify(rules, null, 2)}`);
      }

      case "remove": {
        const ruleId = typeof args.rule_id === "string" ? args.rule_id.trim() : "";
        if (!ruleId) throw new Error("rule_id é obrigatório para action=remove.");
        const removed = await cdp.removeInterceptRule(tabId, ruleId);
        return text(removed ? `Regra ${ruleId} removida.` : `Regra ${ruleId} não encontrada nesta aba.`);
      }

      case "clear": {
        const count = await cdp.clearInterceptRules(tabId);
        return text(`${count} regra(s) de interceptação removida(s) da aba ${tabId}.`);
      }

      case "add": {
        let stage: "Request" | "Response" | undefined;
        if (args.stage !== undefined) {
          const rawStage = String(args.stage).trim().toLowerCase();
          if (rawStage === "request") stage = "Request";
          else if (rawStage === "response") stage = "Response";
          else throw new Error('stage deve ser "Request" ou "Response".');
        } else if (args.override_status !== undefined || args.status_filter !== undefined) {
          stage = "Response";
        } else if (args.block === true || args.override_url !== undefined || args.override_method !== undefined) {
          stage = "Request";
        } else {
          throw new Error('stage ("Request" ou "Response") é obrigatório para action=add.');
        }

        const block = args.block === true;
        if (block && stage !== "Request") {
          throw new Error('block=true só é suportado em stage="Request".');
        }

        let statusFilter: number | undefined;
        if (args.status_filter !== undefined) {
          if (stage !== "Response") throw new Error('status_filter só é válido em stage="Response".');
          if (typeof args.status_filter !== "number" || !Number.isInteger(args.status_filter)) {
            throw new Error("status_filter deve ser um número inteiro.");
          }
          statusFilter = args.status_filter;
        }

        let overrideStatus: number | undefined;
        if (args.override_status !== undefined) {
          if (stage !== "Response") throw new Error('override_status só é válido em stage="Response".');
          if (
            typeof args.override_status !== "number" ||
            !Number.isInteger(args.override_status) ||
            args.override_status < 100 ||
            args.override_status > 599
          ) {
            throw new Error("override_status deve ser um inteiro entre 100 e 599.");
          }
          overrideStatus = args.override_status;
        }

        const overrideUrl = typeof args.override_url === "string" && args.override_url.trim() ? args.override_url.trim() : undefined;
        if (overrideUrl && stage !== "Request") throw new Error('override_url só é válido em stage="Request".');

        const overrideMethod =
          typeof args.override_method === "string" && args.override_method.trim()
            ? args.override_method.trim().toUpperCase()
            : undefined;
        if (overrideMethod && stage !== "Request") throw new Error('override_method só é válido em stage="Request".');

        let setHeaders: Record<string, string> | undefined;
        if (args.set_headers !== undefined) {
          if (typeof args.set_headers !== "object" || args.set_headers === null || Array.isArray(args.set_headers)) {
            throw new Error("set_headers deve ser um objeto {Nome: Valor}.");
          }
          setHeaders = {};
          for (const [k, v] of Object.entries(args.set_headers as Record<string, unknown>)) {
            if (!k.trim() || k.startsWith(":") || v === undefined || v === null) continue;
            setHeaders[k] = String(v);
          }
        }

        const removeHeaders = Array.isArray(args.remove_headers) ? args.remove_headers.map(String).filter(Boolean) : undefined;
        const overrideBody = typeof args.override_body === "string" ? args.override_body : undefined;

        let replaceBody: cdp.BodyReplacement[] | undefined;
        if (args.replace_body !== undefined) {
          if (!Array.isArray(args.replace_body)) throw new Error("replace_body deve ser uma lista de {find, replace, regex?}.");
          replaceBody = args.replace_body.map((item) => {
            const o = (item ?? {}) as Record<string, unknown>;
            if (typeof o.find !== "string" || o.find === "" || o.replace === undefined) {
              throw new Error("cada item de replace_body exige find (não vazio) e replace.");
            }
            return { find: o.find, replace: String(o.replace), regex: o.regex === true };
          });
        }
        if (typeof args.find === "string" && args.find !== "") {
          if (args.replace === undefined) throw new Error("replace é obrigatório ao usar o atalho find.");
          replaceBody = [...(replaceBody ?? []), { find: args.find, replace: String(args.replace), regex: args.regex === true }];
        }

        const rule = await cdp.addInterceptRule(tabId, {
          stage,
          urlPattern: typeof args.url_pattern === "string" ? args.url_pattern : undefined,
          method: typeof args.method === "string" && args.method.trim() ? args.method.trim().toUpperCase() : undefined,
          statusFilter,
          block,
          overrideUrl,
          overrideMethod,
          overrideStatus,
          overrideStatusText: typeof args.override_status_text === "string" ? args.override_status_text : undefined,
          setHeaders,
          removeHeaders,
          overrideBody,
          replaceBody,
        });
        return text(`Regra ${rule.id} ativada na aba ${tabId}:\n${JSON.stringify(rule, null, 2)}`);
      }

      default:
        throw new Error('action deve ser "add", "list", "remove" ou "clear".');
    }
  },

  async http_repeater(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    await cdp.track(tabId);

    const maxBody = Math.min(
      Math.max(typeof args.max_body_chars === "number" ? args.max_body_chars : 20_000, 1_000),
      256_000,
    );
    const followRedirects = args.follow_redirects !== false;

    let method = "GET";
    let rawUrl = "";
    let clonedHeaders: Record<string, string> = {};
    let body: string | undefined;

    if (typeof args.request_id === "string" && args.request_id) {
      const entry = cdp.networkEntries(tabId).find((e) => e.id === args.request_id);
      if (!entry) throw new Error(`requisição ${args.request_id} não encontrada.`);
      if (entry.hasPostData && entry.postData === undefined) {
        const post = await cdp
          .send<{ postData?: string }>(tabId, "Network.getRequestPostData", { requestId: args.request_id })
          .catch(() => undefined);
        if (typeof post?.postData === "string") entry.postData = post.postData.slice(0, 256 * 1024);
      }
      method = entry.method.toUpperCase();
      rawUrl = entry.url;
      clonedHeaders = args.replace_headers === true ? {} : { ...(entry.requestHeaders ?? {}) };
      body = entry.postData;
    }

    if (typeof args.url === "string" && args.url.trim()) {
      rawUrl = normalizeUrl(args.url);
    }
    if (!rawUrl) throw new Error("informe request_id ou url.");
    let targetUrl: string;
    try {
      targetUrl = new URL(rawUrl).href;
    } catch {
      throw new Error(`URL inválida: ${rawUrl}`);
    }

    if (typeof args.method === "string" && args.method.trim()) {
      method = args.method.trim().toUpperCase();
    }
    if (args.body !== undefined && args.body !== null) {
      body = String(args.body);
    }

    const removeSet = new Set(
      (Array.isArray(args.remove_headers) ? args.remove_headers.map(String).filter(Boolean) : []).map((k) =>
        k.toLowerCase(),
      ),
    );
    const mergedHeaders: Record<string, string> = {};
    const lowerMap = new Map<string, string>();
    for (const [k, v] of Object.entries(clonedHeaders)) {
      const low = k.toLowerCase();
      if (k.startsWith(":") || removeSet.has(low)) continue;
      const prevKey = lowerMap.get(low);
      if (prevKey && prevKey !== k) delete mergedHeaders[prevKey];
      lowerMap.set(low, k);
      mergedHeaders[k] = v;
    }

    const explicitHeaders: Record<string, string> = {};
    if (args.headers !== undefined) {
      if (typeof args.headers !== "object" || args.headers === null || Array.isArray(args.headers)) {
        throw new Error("headers deve ser um objeto {Nome: Valor}.");
      }
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
        if (!k.trim() || k.startsWith(":") || v === undefined || v === null) continue;
        const val = String(v);
        explicitHeaders[k] = val;
        const low = k.toLowerCase();
        const prevKey = lowerMap.get(low);
        if (prevKey && prevKey !== k) delete mergedHeaders[prevKey];
        lowerMap.set(low, k);
        mergedHeaders[k] = val;
      }
    }

    const jsHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(mergedHeaders)) {
      if (!isForbiddenFetchHeader(k)) jsHeaders[k] = v;
    }
    const cdpForcedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(explicitHeaders)) {
      if (isForbiddenFetchHeader(k)) cdpForcedHeaders[k] = v;
    }
    const cdpForcedRemove: string[] = [];
    for (const name of removeSet) {
      if (isForbiddenFetchHeader(name)) cdpForcedRemove.push(name);
    }

    const reqBody = method !== "GET" && method !== "HEAD" ? body : undefined;
    type RepeaterResp = {
      status: number;
      statusText: string;
      url: string;
      redirected: boolean;
      headers: [string, string][];
      body: string;
      ms: number;
      via: string;
    };

    const runInTab = async (): Promise<RepeaterResp> => {
      const payload = JSON.stringify({
        url: targetUrl,
        method,
        headers: jsHeaders,
        body: reqBody ?? null,
        redirect: followRedirects ? "follow" : "manual",
      });
      const expr = `(async () => {
        const cfg = ${payload};
        const t0 = performance.now();
        try {
          const init = {
            method: cfg.method,
            headers: cfg.headers,
            credentials: "include",
            redirect: cfg.redirect,
          };
          if (cfg.body !== null) init.body = cfg.body;
          const resp = await fetch(cfg.url, init);
          const text = await resp.text();
          return {
            ok: true,
            status: resp.status,
            statusText: resp.statusText,
            url: resp.url,
            redirected: resp.redirected,
            type: resp.type,
            headers: Array.from(resp.headers.entries()),
            body: text,
            ms: Math.round(performance.now() - t0),
          };
        } catch (e) {
          return { __error: e && e.message ? e.message : String(e), __name: e && e.name ? e.name : "" };
        }
      })()`;
      const r = await cdp.send<{
        result?: { value?: Record<string, unknown> };
        exceptionDetails?: { exception?: { description?: string }; text: string };
      }>(tabId, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30_000 });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      const val = r.result?.value;
      if (!val || typeof val !== "object") throw new Error("resposta vazia do fetch na aba.");
      if ("__error" in val) throw new Error(String(val.__error));
      if (val.type === "opaqueredirect") {
        return {
          status: 302,
          statusText: "(opaque redirect — navegador ocultou headers/location com follow_redirects=false)",
          url: String(val.url || targetUrl),
          redirected: true,
          headers: [],
          body: "",
          ms: Number(val.ms ?? 0),
          via: "aba",
        };
      }
      return {
        status: Number(val.status ?? 0),
        statusText: String(val.statusText ?? ""),
        url: String(val.url || targetUrl),
        redirected: Boolean(val.redirected),
        headers: Array.isArray(val.headers) ? (val.headers as [string, string][]) : [],
        body: String(val.body ?? ""),
        ms: Number(val.ms ?? 0),
        via: "aba",
      };
    };

    const runInExtension = async (): Promise<RepeaterResp> => {
      const t0 = Date.now();
      const init: RequestInit = {
        method,
        headers: jsHeaders,
        credentials: "include",
        redirect: followRedirects ? "follow" : "manual",
      };
      if (reqBody !== undefined) init.body = reqBody;
      const resp = await fetch(targetUrl, init);
      const respText = await resp.text();
      return {
        status: resp.status,
        statusText: resp.statusText,
        url: resp.url || targetUrl,
        redirected: resp.redirected,
        headers: Array.from(resp.headers.entries()),
        body: respText,
        ms: Date.now() - t0,
        via: "extensão (cross-origin/CORS bypass)",
      };
    };

    let result: RepeaterResp;
    let cdpOverrideActive = Object.keys(cdpForcedHeaders).length > 0 || cdpForcedRemove.length > 0;
    const canRunInTab = !cdp.isRestricted(tab.url) && Boolean(tab.url && /^https?:\/\//i.test(tab.url)) && !cdp.pendingDialog(tabId);
    if (canRunInTab) {
      try {
        result = cdpOverrideActive
          ? await cdp.withOneShotRequestHeaders(
              tabId,
              { url: targetUrl, method, setHeaders: cdpForcedHeaders, removeHeaders: cdpForcedRemove },
              runInTab,
            )
          : await runInTab();
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (/failed to fetch|cors|networkerror/i.test(msg)) {
          result = await runInExtension();
        } else {
          throw e;
        }
      }
    } else {
      result = await runInExtension();
    }

    const out: string[] = [];
    out.push("=== REPEATED REQUEST ===");
    out.push(`${method} ${targetUrl}`);
    const displayReqHeaders = result.via === "aba" ? mergedHeaders : jsHeaders;
    const reqHdrLines = formatHeaders(displayReqHeaders);
    out.push(...(reqHdrLines.length ? reqHdrLines : ["(sem headers explícitos; cookies da sessão incluídos)"]));
    if (result.via !== "aba" && cdpOverrideActive) {
      out.push(
        `(aviso: fallback cross-origin executado fora da aba; headers restritos [${Object.keys(cdpForcedHeaders).concat(cdpForcedRemove).join(", ")}] não foram sobrescritos via CDP)`,
      );
    }
    if (reqBody !== undefined) {
      out.push("");
      out.push(reqBody.slice(0, maxBody));
      if (reqBody.length > maxBody) {
        out.push(`\n(request body truncado em ${maxBody} caracteres de ${reqBody.length})`);
      }
    }

    out.push("");
    out.push(`=== RESPONSE (${result.ms}ms, via ${result.via}) ===`);
    out.push(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""}`);
    if (result.redirected && result.url && result.url !== targetUrl) {
      out.push(`Final-URL: ${result.url}`);
    }
    if (result.headers.length) {
      for (const [k, v] of result.headers) out.push(`${k}: ${v}`);
    } else {
      out.push("(nenhum header de resposta exposto)");
    }
    out.push("");
    if (result.body.length === 0) {
      out.push("(sem corpo)");
    } else {
      out.push(result.body.slice(0, maxBody));
      if (result.body.length > maxBody) {
        out.push(`\n(response body truncado em ${maxBody} caracteres de ${result.body.length})`);
      }
    }
    const res = text(out.join("\n"));
    if (args.artex_ingest === true) {
      res._artex_exchanges = [
        {
          method,
          url: result.url || targetUrl,
          status: result.status,
          requestHeaders: sanitizeArtexHeaders(displayReqHeaders),
          requestBody: (reqBody ?? "").slice(0, ARTEX_MAX_BODY),
          responseHeaders: sanitizeArtexHeaders(result.headers),
          responseBody: result.body.slice(0, ARTEX_MAX_BODY),
        },
      ];
    }
    return res;
  },
};

const STOPPED =
  "O usuário pausou o agente pelo botão Parar no navegador. Não continue a tarefa: " +
  "pergunte ao usuário como prosseguir. Novas ações ficam bloqueadas até ele clicar em Retomar.";

// Chamadas em andamento por sessão, para o botão Parar poder interrompê-las.
const inflight = new Map<string, Set<(e: Error) => void>>();
// Chamadas em andamento por id do host, para cancelar uma só.
const calls = new Map<string, (e: Error) => void>();

/**
 * Prazo de uma chamada inteira, pedidos de permissão incluídos. Fica abaixo do
 * timeout do `oba mcp` (CallTimeout em host/internal/mcp/server.go), para o
 * agente receber este erro, que explica o que houve, e nunca um timeout do
 * host com a ação ainda rodando no navegador.
 */
const CALL_DEADLINE_MS = 210_000;

const DEADLINE =
  `A chamada passou de ${CALL_DEADLINE_MS / 1000}s (provavelmente esperando o usuário aprovar no navegador) e foi interrompida. ` +
  "Confira o estado da aba antes de tentar de novo.";

/** O agente desistiu da chamada (timeout do host ou cancelamento MCP). */
export function abortCall(id: string): void {
  calls.get(id)?.(new Error("Chamada cancelada pelo agente."));
  calls.delete(id);
}

/** Interrompe as chamadas em andamento da sessão (a resposta volta como erro). */
export function abortSession(session: string): void {
  for (const reject of inflight.get(session) ?? []) reject(new Error(STOPPED));
  inflight.delete(session);
}

const errorResult = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: String((e as Error)?.message ?? e) }],
  isError: true,
});

// Ferramentas que leem ou agem sobre o conteúdo da página atual.
const PAGE_TOOLS = new Set([
  "read_page", "find", "get_page_text", "computer", "screenshot", "form_input", "file_upload",
  "read_console", "read_network", "javascript", "handle_dialog", "gif_creator",
  "cookies", "storage", "http_headers", "intercept_rules", "http_repeater",
]);

// Ações que geram um quadro quando o GIF está gravando.
const GIF_TOOLS = new Set(["computer", "navigate", "form_input", "file_upload", "handle_dialog"]);

async function gifFrame(name: string, args: Args, tabId: number, stealth = false): Promise<void> {
  if (!gif.isRecording(tabId) || !GIF_TOOLS.has(name)) return;
  if (name === "computer" && ["screenshot", "wait"].includes(String(args.action))) return;
  try {
    await sleep(250); // deixa a página reagir antes do quadro
    const tab = await chrome.tabs.get(tabId);
    const shot = await capture(tab, "jpeg", stealth);
    gif.addFrame(tabId, shot, `${name} ${summarize(name, args)}`.trim(), lastPoint.get(tabId));
  } catch {
    /* diálogo aberto ou página interna: pula o quadro */
  } finally {
    lastPoint.delete(tabId);
  }
}
const HISTORY = new Set(["back", "forward", "reload"]);

/** Checa pareamento do agente e permissão do(s) site(s) envolvidos. */
async function authorize(name: string, ctx: Ctx, args: Args): Promise<void> {
  const stealth = ctx.stealth === true;
  await permissions.checkClient(ctx.session, ctx.client, stealth);
  if (name === "navigate" || name === "tabs_create") {
    const dest = typeof args.url === "string" ? args.url.trim() : "";
    if (dest && !HISTORY.has(dest.toLowerCase())) {
      await permissions.checkSite(ctx.session, ctx.client, normalizeUrl(dest), stealth);
    }
  } else if (PAGE_TOOLS.has(name) && typeof args.tab_id === "number") {
    const tab = await chrome.tabs.get(args.tab_id).catch(() => undefined);
    await permissions.checkSite(ctx.session, ctx.client, tab?.url, stealth);
  }
  if (name === "http_repeater" && typeof args.url === "string" && args.url.trim()) {
    await permissions.checkSite(ctx.session, ctx.client, normalizeUrl(args.url), stealth);
  }
}

/** Resumo curto dos argumentos para o log do side panel. */
function summarize(name: string, args: Args): string {
  const parts: string[] = [];
  if (typeof args.action === "string") parts.push(args.action);
  for (const k of ["url", "url_pattern", "method", "request_id", "query", "ref", "text", "filter", "name", "key"] as const) {
    const v = args[k];
    if (typeof v === "string" && v) parts.push(k === "text" && args.action === "type" ? `"${v.length > 24 ? v.slice(0, 23) + "…" : v}"` : v);
  }
  if (Array.isArray(args.coordinate)) parts.push(`(${args.coordinate.join(", ")})`);
  return parts.join(" ").slice(0, 120);
}

async function log(entry: LogEntry): Promise<void> {
  const list = await getSession<LogEntry[]>(K.log, []);
  list.unshift(entry);
  await chrome.storage.session.set({ [K.log]: list.slice(0, 100) });
}

export async function run(name: string, ctx: Ctx, args: Args): Promise<ToolResult> {
  args ??= {};
  const handler = handlers[name];
  const revived = await sessions.revive(ctx.session);
  let result: ToolResult;
  if (!handler) {
    result = errorResult(`ferramenta desconhecida: ${name}`);
  } else if ((await sessions.info(ctx.session))?.stopped) {
    result = errorResult(STOPPED);
  } else {
    result = await execute(handler, name, ctx, args);
  }
  if (revived) {
    result.content.unshift({ type: "text", text: "(Sessão retomada: as abas abertas pelo processo anterior deste agente continuam no grupo; tabs_context lista os tab_id.)" });
  }
  const err = result.isError ? result.content.find((c) => c.type === "text")?.text : undefined;
  await log({ t: Date.now(), client: ctx.client, tool: name, detail: summarize(name, args), ok: !result.isError, error: err?.slice(0, 200) });
  return result;
}

async function execute(handler: Handler, name: string, ctx: Ctx, args: Args): Promise<ToolResult> {
  let rejectRace!: (e: Error) => void;
  const aborted = new Promise<never>((_, r) => (rejectRace = r));
  // O sinal avisa handlers de várias etapas (batch) para não começar a próxima.
  const ac = new AbortController();
  const reject = (e: Error) => {
    ac.abort(e);
    rejectRace(e);
  };
  // Etapa de um batch: cancelar o batch interrompe também a etapa em andamento.
  const parent = ctx.signal;
  const onParentAbort = () => reject(parent!.reason instanceof Error ? parent!.reason : new Error("Chamada cancelada."));
  parent?.addEventListener("abort", onParentAbort, { once: true });
  ctx = { ...ctx, signal: ac.signal };
  const set = inflight.get(ctx.session) ?? new Set();
  set.add(reject);
  inflight.set(ctx.session, set);
  if (ctx.call) calls.set(ctx.call, reject);
  const deadline = setTimeout(() => reject(new Error(DEADLINE)), CALL_DEADLINE_MS);

  let tabId: number | undefined;
  try {
    await Promise.race([authorize(name, ctx, args), aborted]);

    // Liga a borda "trabalhando" na aba alvo enquanto a ferramenta roda (omitida em stealth).
    if (typeof args.tab_id === "number" && name !== "tabs_close") {
      try {
        tabId = (await sessions.ownedTab(ctx.session, ctx.client, args.tab_id)).id;
        if (ctx.stealth) cdp.setStealthTab(tabId!, true);
        else await overlay.attach(tabId!, ctx.client, { busy: true });
      } catch {
        tabId = undefined; // o handler reporta o erro de aba
      }
    }
    const result = await Promise.race([handler(ctx, args), aborted]);
    if (!result.isError && typeof args.tab_id === "number") await gifFrame(name, args, args.tab_id, ctx.stealth === true);
    return result;
  } catch (e) {
    return errorResult(e);
  } finally {
    parent?.removeEventListener("abort", onParentAbort);
    clearTimeout(deadline);
    set.delete(reject);
    if (ctx.call) calls.delete(ctx.call);
    if (tabId !== undefined && !ctx.stealth) await overlay.setBusy(tabId, false);
  }
}
