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

export type ToolResult = { content: Content[]; isError?: boolean };

/** `call` identifica a chamada para o host poder cancelá-la (ver abortCall). */
export type Ctx = { session: string; client: string; call?: string };
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
async function capture(tab: chrome.tabs.Tab, format: "jpeg" | "png") {
  const tabId = tab.id!;
  if (cdp.isRestricted(tab.url)) throw new Error(`o navegador não permite capturar ${tab.url}.`);
  const dialog = cdp.pendingDialog(tabId);
  if (dialog) throw cdp.dialogError(dialog);
  await activate(tab);
  const { data } = await overlay.hiddenDuring(tabId, () =>
    cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: 80 } : {}),
    }),
  );
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

async function screenshotResult(tab: chrome.tabs.Tab, format: "jpeg" | "png", prefix = ""): Promise<ToolResult> {
  const shot = await capture(tab, format);
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
  try {
    const raced = await Promise.race([
      computerAction(tab, action, args),
      watcher.promise.then((d) => ({ dialog: d })),
    ]);
    if ("dialog" in raced) {
      const d = raced.dialog;
      return text(`${action} executado. A página abriu um diálogo ${d.type}: "${d.message}". ` +
        `Ela fica bloqueada até você responder com handle_dialog (accept=true/false${d.type === "prompt" ? ", prompt_text" : ""}).`);
    }
    return raced;
  } finally {
    watcher.cancel();
  }
}

async function computerAction(tab: chrome.tabs.Tab, action: string, args: Args): Promise<ToolResult> {
  const tabId = tab.id!;
  switch (action) {
    case "screenshot":
      return screenshotResult(tab, "jpeg");

    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const t = await target(tabId, args);
      const button: input.Button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      const count = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      lastPoint.set(tabId, t);
      await overlay.pointAt(tabId, t.x, t.y, () => input.click(tabId, t.x, t.y, button, count, modifiers(args.modifiers)));
      return text(`${action} em (${t.x}, ${t.y})${t.note}`);
    }

    case "hover": {
      const t = await target(tabId, args);
      lastPoint.set(tabId, t);
      await overlay.pointAt(tabId, t.x, t.y, () => input.move(tabId, t.x, t.y), false);
      return text(`Mouse sobre (${t.x}, ${t.y})${t.note}`);
    }

    case "left_click_drag": {
      const from = coord(args.start_coordinate, "start_coordinate");
      const to = coord(args.coordinate);
      await overlay.pointAt(tabId, from[0], from[1], () => input.drag(tabId, from, to), false);
      await overlay.pointAt(tabId, to[0], to[1], async () => {}, false);
      return text(`Arrastou de (${from}) para (${to})`);
    }

    case "type": {
      const value = String(args.text ?? "");
      if (!value) throw new Error("text é obrigatório para action=type.");
      let where = "no elemento focado";
      if (args.ref || args.coordinate) {
        const t = await target(tabId, args);
        lastPoint.set(tabId, t);
        await overlay.pointAt(tabId, t.x, t.y, () => input.click(tabId, t.x, t.y));
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

const handlers: Record<string, Handler> = {
  async tabs_context(ctx, args) {
    let tabs = await sessions.listTabs(ctx.session, ctx.client);
    if (tabs.length === 0 && args.create_if_empty === true) {
      await sessions.createTab(ctx.session, ctx.client);
      tabs = await sessions.listTabs(ctx.session, ctx.client);
    }
    return text(describe(tabs));
  },

  async tabs_create(ctx, args) {
    const url = typeof args.url === "string" && args.url ? normalizeUrl(args.url) : undefined;
    // Cria vazia e só então navega, para o listener de carregamento já estar ativo.
    const tab = await sessions.createTab(ctx.session, ctx.client);
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
    const fresh = await chrome.tabs.get(tabId);
    const note = loaded ? "" : "\n(aviso: o carregamento não terminou em 30s)";
    return text(`Navegou para ${fresh.url}\nTítulo: ${fresh.title}${note}`);
  },

  async screenshot(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    return screenshotResult(tab, args.format === "png" ? "png" : "jpeg");
  },

  async read_page(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const out = await page.call<string>(tab.id!, "readPage", {
      filter: args.filter,
      max_depth: typeof args.max_depth === "number" ? args.max_depth : undefined,
      ref_id: typeof args.ref_id === "string" ? args.ref_id : undefined,
    });
    return text(out);
  },

  async find(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const query = String(args.query ?? "");
    const limit = typeof args.limit === "number" ? args.limit : 20;
    return text(await page.call<string>(tab.id!, "find", query, limit));
  },

  async get_page_text(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    return text(await page.call<string>(tab.id!, "pageText"));
  },

  computer,

  async form_input(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    if (typeof args.ref !== "string") throw new Error("ref é obrigatório (de read_page/find).");
    if (args.value === undefined) throw new Error("value é obrigatório.");
    return text(await page.call<string>(tab.id!, "formInput", args.ref, args.value));
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
    if (typeof args.request_id === "string") {
      const entry = cdp.networkEntries(tabId).find((e) => e.id === args.request_id);
      if (!entry) throw new Error(`requisição ${args.request_id} não encontrada.`);
      const body = await cdp.send<{ body: string; base64Encoded: boolean }>(tabId, "Network.getResponseBody", { requestId: args.request_id })
        .catch((e) => { throw new Error(`corpo indisponível (${(e as Error).message}); só respostas ainda em memória podem ser lidas.`); });
      if (body.base64Encoded) return text(`${entry.method} ${entry.url} → ${entry.status} ${entry.mimeType}: corpo binário (${Math.round(body.body.length * 0.75 / 1024)} KB), não exibido.`);
      const max = 20_000;
      return text(`${entry.method} ${entry.url} → ${entry.status} ${entry.mimeType}\n\n${body.body.slice(0, max)}${body.body.length > max ? `\n\n(truncado em ${max} caracteres de ${body.body.length})` : ""}`);
    }
    let list = cdp.networkEntries(tabId);
    if (typeof args.url_pattern === "string" && args.url_pattern) list = list.filter((e) => e.url.includes(args.url_pattern as string));
    if (args.only_errors === true) list = list.filter((e) => e.error || (e.status ?? 0) >= 400);
    if (args.include_static !== true) list = list.filter((e) => !["Image", "Font", "Stylesheet", "Media"].includes(e.type ?? ""));
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const shown = list.slice(-limit);
    if (args.clear === true) cdp.clearNetwork(tabId);
    if (shown.length === 0) return text("Nenhuma requisição capturada (com esses filtros). A captura começa quando o agente abre/navega a aba.");
    const lines = shown.map((e) => {
      const status = e.error ? `ERRO ${e.error}` : e.status ? `${e.status}` : e.done ? "?" : "pendente";
      const size = e.size !== undefined ? ` ${Math.max(1, Math.round(e.size / 1024))}KB` : "";
      const url = e.url.length > 160 ? e.url.slice(0, 159) + "…" : e.url;
      return `${e.method} ${status} ${e.type ?? ""}${size} ${url}  [id ${e.id}]`;
    });
    return text(`${shown.length} de ${list.length} requisição(ões) (use request_id para ler o corpo):\n${lines.join("\n")}`);
  },

  async file_upload(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    const paths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean) : [];
    if (typeof args.ref !== "string" || paths.length === 0) throw new Error("ref e paths (lista de caminhos absolutos) são obrigatórios.");
    const mark = await page.call<{ token: string; multiple: boolean }>(tabId, "markUpload", args.ref);
    if (paths.length > 1 && !mark.multiple) throw new Error("este campo aceita só um arquivo.");
    await permissions.checkUpload(ctx.client, tab.url, paths);
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
          const shot = await capture(tab, "jpeg");
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
    await permissions.checkJavascript();
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
]);

// Ações que geram um quadro quando o GIF está gravando.
const GIF_TOOLS = new Set(["computer", "navigate", "form_input", "file_upload", "handle_dialog"]);

async function gifFrame(name: string, args: Args, tabId: number): Promise<void> {
  if (!gif.isRecording(tabId) || !GIF_TOOLS.has(name)) return;
  if (name === "computer" && ["screenshot", "wait"].includes(String(args.action))) return;
  try {
    await sleep(250); // deixa a página reagir antes do quadro
    const tab = await chrome.tabs.get(tabId);
    const shot = await capture(tab, "jpeg");
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
  await permissions.checkClient(ctx.session, ctx.client);
  if (name === "navigate" || name === "tabs_create") {
    const dest = typeof args.url === "string" ? args.url.trim() : "";
    if (dest && !HISTORY.has(dest.toLowerCase())) {
      await permissions.checkSite(ctx.session, ctx.client, normalizeUrl(dest));
    }
  } else if (PAGE_TOOLS.has(name) && typeof args.tab_id === "number") {
    const tab = await chrome.tabs.get(args.tab_id).catch(() => undefined);
    await permissions.checkSite(ctx.session, ctx.client, tab?.url);
  }
}

/** Resumo curto dos argumentos para o log do side panel. */
function summarize(name: string, args: Args): string {
  const parts: string[] = [];
  if (typeof args.action === "string") parts.push(args.action);
  for (const k of ["url", "query", "ref", "text", "filter"] as const) {
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
  let result: ToolResult;
  if (!handler) {
    result = errorResult(`ferramenta desconhecida: ${name}`);
  } else if ((await sessions.info(ctx.session))?.stopped) {
    result = errorResult(STOPPED);
  } else {
    result = await execute(handler, name, ctx, args);
  }
  const err = result.isError ? result.content.find((c) => c.type === "text")?.text : undefined;
  await log({ t: Date.now(), client: ctx.client, tool: name, detail: summarize(name, args), ok: !result.isError, error: err?.slice(0, 200) });
  return result;
}

async function execute(handler: Handler, name: string, ctx: Ctx, args: Args): Promise<ToolResult> {
  let reject!: (e: Error) => void;
  const aborted = new Promise<never>((_, r) => (reject = r));
  const set = inflight.get(ctx.session) ?? new Set();
  set.add(reject);
  inflight.set(ctx.session, set);
  if (ctx.call) calls.set(ctx.call, reject);
  const deadline = setTimeout(() => reject(new Error(DEADLINE)), CALL_DEADLINE_MS);

  let tabId: number | undefined;
  try {
    await Promise.race([authorize(name, ctx, args), aborted]);

    // Liga a borda "trabalhando" na aba alvo enquanto a ferramenta roda.
    if (typeof args.tab_id === "number" && name !== "tabs_close") {
      try {
        tabId = (await sessions.ownedTab(ctx.session, ctx.client, args.tab_id)).id;
        await overlay.attach(tabId!, ctx.client, { busy: true });
      } catch {
        tabId = undefined; // o handler reporta o erro de aba
      }
    }
    const result = await Promise.race([handler(ctx, args), aborted]);
    if (!result.isError && typeof args.tab_id === "number") await gifFrame(name, args, args.tab_id);
    return result;
  } catch (e) {
    return errorResult(e);
  } finally {
    clearTimeout(deadline);
    set.delete(reject);
    if (ctx.call) calls.delete(ctx.call);
    if (tabId !== undefined) await overlay.setBusy(tabId, false);
  }
}
