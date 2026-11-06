// Lado do service worker do chat embutido. O loop do agente (chamadas ao
// modelo) roda no side panel; aqui ficam só a preparação da aba e a execução
// das ferramentas, pelo mesmo caminho dos agentes MCP (tools.run).

import * as sessions from "./sessions";
import { CHAT_CLIENT, CHAT_SESSION, siteOf } from "./store";
import * as tools from "./tools";

const ctx = { session: CHAT_SESSION, client: CHAT_CLIENT };

export type TabInfo = { tab_id: number; title?: string; url?: string };

/**
 * Chamado quando o usuário envia uma mensagem: retoma a sessão se estava
 * pausada, põe a aba atual no grupo do chat e libera o site dela nesta sessão
 * (o usuário pediu explicitamente para agir aqui). Sites bloqueados continuam
 * bloqueados.
 */
export async function begin(tabId: number): Promise<TabInfo> {
  if ((await sessions.info(CHAT_SESSION))?.stopped) await sessions.setStopped(CHAT_SESSION, false);
  const tab = await sessions.adoptTab(CHAT_SESSION, CHAT_CLIENT, tabId);
  const site = siteOf(tab.url);
  await sessions.patch(CHAT_SESSION, CHAT_CLIENT, { approved: true });
  if (site) await sessions.addSite(CHAT_SESSION, CHAT_CLIENT, site);
  return { tab_id: tab.id!, title: tab.title, url: tab.url };
}

/**
 * Fim de um pedido: solta depurador e overlay das abas do chat. Sem isso a aba
 * do usuário ficaria com a barra "está depurando" e com o beforeunload ("Sair
 * do site?") aceito automaticamente, mesmo quando é o usuário que sai da página.
 */
export function end(): Promise<void> {
  return sessions.idle(CHAT_SESSION);
}

/** Conversa trocada ou painel fechado: interrompe e devolve as abas ao usuário. */
export async function release(): Promise<void> {
  abort();
  await sessions.release(CHAT_SESSION);
}

export function run(name: string, args: Record<string, unknown>): Promise<tools.ToolResult> {
  return tools.run(name, ctx, args);
}

export function abort(): void {
  tools.abortSession(CHAT_SESSION);
}
