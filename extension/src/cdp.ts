// Wrapper fino sobre chrome.debugger (Chrome DevTools Protocol).

const PROTOCOL = "1.3";
const attached = new Set<number>();

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId !== undefined) attached.delete(src.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));

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
  // Faz a página se comportar como focada mesmo com o usuário em outra janela
  // (ex.: no terminal do agente); sem isso, foco e digitação podem falhar.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch {
    /* opcional */
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
