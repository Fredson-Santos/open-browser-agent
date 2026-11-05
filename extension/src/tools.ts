// Implementação das ferramentas MCP. Cada uma recebe os argumentos do agente e
// devolve um CallToolResult do MCP.

import * as cdp from "./cdp";
import * as input from "./input";
import * as page from "./page";
import * as sessions from "./sessions";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: Content[]; isError?: boolean };

export type Ctx = { session: string; client: string };
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
  await activate(tab);
  const { data } = await cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality: 80 } : {}),
  });
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

async function computer(ctx: Ctx, args: Args): Promise<ToolResult> {
  const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
  const tabId = tab.id!;
  const action = String(args.action ?? "");
  if (action !== "wait" && cdp.isRestricted(tab.url)) {
    throw new Error(`o navegador não permite automatizar ${tab.url}.`);
  }
  if (action !== "wait") await activate(tab);

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
      await input.click(tabId, t.x, t.y, button, count, modifiers(args.modifiers));
      return text(`${action} em (${t.x}, ${t.y})${t.note}`);
    }

    case "hover": {
      const t = await target(tabId, args);
      await input.move(tabId, t.x, t.y);
      return text(`Mouse sobre (${t.x}, ${t.y})${t.note}`);
    }

    case "left_click_drag": {
      const from = coord(args.start_coordinate, "start_coordinate");
      const to = coord(args.coordinate);
      await input.drag(tabId, from, to);
      return text(`Arrastou de (${from}) para (${to})`);
    }

    case "type": {
      const value = String(args.text ?? "");
      if (!value) throw new Error("text é obrigatório para action=type.");
      let where = "no elemento focado";
      if (args.ref || args.coordinate) {
        const t = await target(tabId, args);
        await input.click(tabId, t.x, t.y);
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
};

export async function run(name: string, ctx: Ctx, args: Args): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) return { content: [{ type: "text", text: `ferramenta desconhecida: ${name}` }], isError: true };
  try {
    return await handler(ctx, args ?? {});
  } catch (e) {
    return { content: [{ type: "text", text: String((e as Error)?.message ?? e) }], isError: true };
  }
}
