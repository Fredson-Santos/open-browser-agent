// Controla o overlay visual (overlay.js) nas abas, a partir do service worker.
// Falhas são ignoradas: páginas internas não aceitam scripts e o overlay é só feedback.

type Method = "show" | "hide" | "unhide" | "remove" | "setBusy" | "setStopped" | "setPassthrough" | "moveCursor" | "clickEffect";

async function exec(tabId: number, method: Method, args: unknown[], inject: boolean): Promise<unknown> {
  const run = () =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: (m: string, a: unknown[]) => {
        const o = (window as unknown as { __obaOverlay?: Record<string, (...x: unknown[]) => unknown> }).__obaOverlay;
        if (!o) return { missing: true };
        return { value: o[m](...a) };
      },
      args: [method, args],
    });
  let [r] = await run();
  let res = r?.result as { missing?: boolean; value?: unknown } | undefined;
  if (res?.missing) {
    if (!inject) return undefined;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
    [r] = await run();
    res = r?.result as typeof res;
  }
  return res?.value;
}

async function safe<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

/** Mostra o overlay na aba (injetando se preciso) com o estado da sessão. */
export async function attach(tabId: number, client: string, opts: { busy?: boolean; stopped?: boolean } = {}) {
  await safe(
    (async () => {
      await exec(tabId, "show", [client], true);
      await exec(tabId, "setStopped", [!!opts.stopped], false);
      await exec(tabId, "setBusy", [!!opts.busy], false);
    })(),
  );
}

export const setBusy = (tabId: number, busy: boolean) => safe(exec(tabId, "setBusy", [busy], false));
export const setStopped = (tabId: number, stopped: boolean) => safe(exec(tabId, "setStopped", [stopped], false));
export const remove = (tabId: number) => safe(exec(tabId, "remove", [], false));

/** Esconde o overlay durante fn (screenshots não devem mostrar a borda nem a pílula). */
export async function hiddenDuring<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  await safe(exec(tabId, "hide", [], false));
  try {
    return await fn();
  } finally {
    await safe(exec(tabId, "unhide", [], false));
  }
}

/**
 * Anima o cursor até o ponto e executa a ação. Durante a ação a pílula fica
 * transparente a cliques, para o agente não acertar o botão Parar sem querer.
 */
export async function pointAt<T>(tabId: number, x: number, y: number, fn: () => Promise<T>, click = true): Promise<T> {
  const d = (await safe(exec(tabId, "moveCursor", [x, y], true))) as number | undefined;
  if (d) await new Promise((r) => setTimeout(r, d + 40));
  await safe(exec(tabId, "setPassthrough", [true], false));
  try {
    const result = await fn();
    if (click) await safe(exec(tabId, "clickEffect", [x, y], false));
    return result;
  } finally {
    await safe(exec(tabId, "setPassthrough", [false], false));
  }
}
