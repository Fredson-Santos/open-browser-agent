// Chama funções do motor de percepção (content.js) dentro da aba,
// injetando-o sob demanda na primeira vez.

import * as cdp from "./cdp";

type Reply = { __missing?: true; ok?: unknown; err?: string } | undefined;

async function exec(tabId: number, method: string, args: unknown[]): Promise<Reply> {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m: string, a: unknown[]) => {
      const api = (window as unknown as { __oba?: Record<string, (...x: unknown[]) => unknown> }).__oba;
      if (!api) return { __missing: true as const };
      try {
        return { ok: api[m](...a) };
      } catch (e) {
        return { err: String((e as Error)?.message ?? e) };
      }
    },
    args: [method, args],
  });
  return r?.result as Reply;
}

export async function call<T>(tabId: number, method: string, ...args: unknown[]): Promise<T> {
  // Com um alert/confirm aberto a página não executa scripts: falha logo, explicando.
  const dialog = cdp.pendingDialog(tabId);
  if (dialog) throw cdp.dialogError(dialog);
  let res: Reply;
  try {
    res = await exec(tabId, method, args);
    if (res?.__missing) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      res = await exec(tabId, method, args);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/cannot access|cannot be scripted|extensions gallery/i.test(msg)) {
      throw new Error("o navegador não permite que extensões leiam esta página (página interna ou protegida).");
    }
    throw new Error(`falha ao acessar a página: ${msg}`);
  }
  if (!res) throw new Error("a página não respondeu (ainda carregando?).");
  if (res.err) throw new Error(res.err);
  return res.ok as T;
}

export type Point = { x: number; y: number; width: number; height: number; covered_by?: string; in_viewport: boolean };
export type Viewport = { width: number; height: number; dpr: number; scrollX: number; scrollY: number };
