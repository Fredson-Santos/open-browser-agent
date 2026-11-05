// Implementação das ferramentas MCP. Cada uma recebe os argumentos do agente e
// devolve um CallToolResult do MCP.

import * as cdp from "./cdp";
import * as sessions from "./sessions";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: Content[]; isError?: boolean };

export type Ctx = { session: string; client: string };
type Args = Record<string, unknown>;
type Handler = (ctx: Ctx, args: Args) => Promise<ToolResult>;

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

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
    const target = String(args.url ?? "").trim();
    if (!target) throw new Error("url é obrigatória.");

    const { done } = waitForLoad(tabId);
    switch (target.toLowerCase()) {
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
        await chrome.tabs.update(tabId, { url: normalizeUrl(target) });
    }
    const loaded = await done;
    const fresh = await chrome.tabs.get(tabId);
    const note = loaded ? "" : "\n(aviso: o carregamento não terminou em 30s)";
    return text(`Navegou para ${fresh.url}\nTítulo: ${fresh.title}${note}`);
  },

  async screenshot(ctx, args) {
    const tab = await sessions.ownedTab(ctx.session, ctx.client, args.tab_id);
    const tabId = tab.id!;
    if (cdp.isRestricted(tab.url)) throw new Error(`o navegador não permite capturar ${tab.url}.`);
    if (!tab.active) {
      // Abas em segundo plano não são renderizadas; o screenshot ficaria em branco.
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 150));
    }
    const format = args.format === "png" ? "png" : "jpeg";
    const { data } = await cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: 80 } : {}),
    });
    return {
      content: [
        { type: "image", data, mimeType: `image/${format}` },
        { type: "text", text: `Screenshot da aba ${tabId}: ${tab.url}` },
      ],
    };
  },
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
