// Chaves e tipos do armazenamento, compartilhados entre service worker,
// side panel e janela de aprovação.

export const K = {
  /** local: agentes autorizados permanentemente */
  clients: "oba.clients",
  /** local: política por site (host → allow | block) */
  sites: "oba.sites",
  /** local: preferências */
  settings: "oba.settings",
  /** session: sessões ativas (ver sessions.ts) */
  sessions: "oba.sessions",
  /** session: pedidos de aprovação aguardando o usuário */
  pending: "oba.pending",
  /** session: log das últimas ações */
  log: "oba.log",
  /** session: estado da conexão com o native host */
  host: "oba.host",
} as const;

export type ClientGrant = { approvedAt: number };
export type SiteRule = "allow" | "block";
export type Settings = { sitePolicy: "ask" | "allow_all"; allowJavascript?: boolean };
export const DEFAULT_SETTINGS: Settings = { sitePolicy: "ask", allowJavascript: false };

export type Prompt = {
  id: string;
  kind: "client" | "site" | "upload";
  client: string;
  domain?: string;
  files?: string[];
  created: number;
};

export type Decision = "always" | "session" | "deny" | "timeout" | "dismissed";

export type LogEntry = {
  t: number;
  client: string;
  tool: string;
  detail: string;
  ok: boolean;
  error?: string;
};

export type HostState = { connected: boolean; browser?: string; detail?: string; since?: number };

export type SessionView = {
  client: string;
  groupId?: number;
  stopped?: boolean;
  approved?: boolean;
  denied?: boolean;
  sites?: string[];
};

export async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const data = await chrome.storage.local.get(key);
  return (data[key] as T | undefined) ?? fallback;
}

export async function getSession<T>(key: string, fallback: T): Promise<T> {
  const data = await chrome.storage.session.get(key);
  return (data[key] as T | undefined) ?? fallback;
}

/** Normaliza o host para as regras por site (ignora "www."). */
export function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
