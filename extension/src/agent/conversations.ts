// Conversas do chat embutido, em chrome.storage.local: um índice leve
// (título e data) e uma chave por conversa, para não reescrever tudo a cada
// mensagem. Imagens nunca são salvas, e resultados antigos de ferramentas são
// encolhidos para caber na cota.

import { type ChatItem, K } from "../store";
import type { Message } from "./llm";

export type Conversation = {
  id: string;
  title: string;
  created: number;
  updated: number;
  items: ChatItem[];
  history: Message[];
};

export type ConversationMeta = Pick<Conversation, "id" | "title" | "updated">;

const MAX_CONVERSATIONS = 50;
const MAX_SAVED_HISTORY_CHARS = 200_000;
const key = (id: string) => K.convPrefix + id;

export function create(): Conversation {
  const t = Date.now();
  return { id: crypto.randomUUID(), title: "", created: t, updated: t, items: [], history: [] };
}

/** Título a partir da primeira mensagem do usuário. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Nova conversa";
}

export async function list(): Promise<ConversationMeta[]> {
  const data = await chrome.storage.local.get(K.convIndex);
  const idx = (data[K.convIndex] as ConversationMeta[] | undefined) ?? [];
  return [...idx].sort((a, b) => b.updated - a.updated);
}

export async function get(id: string): Promise<Conversation | undefined> {
  const data = await chrome.storage.local.get(key(id));
  return data[key(id)] as Conversation | undefined;
}

function compact(history: Message[]): Message[] {
  const out = history.map((m): Message => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    return { role: "user", content: m.content.map((p) => (p.type === "text" ? p.text : "[screenshot]")).join("\n") };
  });
  let total = out.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
  for (let i = 0; i < out.length && total > MAX_SAVED_HISTORY_CHARS; i++) {
    const m = out[i];
    if (m.role === "tool" && m.content.length > 200) {
      total -= m.content.length;
      out[i] = { ...m, content: "[resultado antigo omitido]" };
    }
  }
  return out;
}

export async function save(conv: Conversation): Promise<void> {
  if (conv.items.length === 0 && conv.history.length === 0) return; // conversa vazia não vai para o histórico
  conv.updated = Date.now();
  const idx = (await list()).filter((c) => c.id !== conv.id);
  idx.unshift({ id: conv.id, title: conv.title || "Nova conversa", updated: conv.updated });
  const dropped = idx.splice(MAX_CONVERSATIONS);
  try {
    await chrome.storage.local.set({
      [key(conv.id)]: { ...conv, items: conv.items.slice(-300), history: compact(conv.history) },
      [K.convIndex]: idx,
      [K.convActive]: conv.id,
    });
    if (dropped.length) await chrome.storage.local.remove(dropped.map((c) => key(c.id)));
  } catch {
    /* cota cheia: a conversa segue em memória até o painel fechar */
  }
}

export async function remove(id: string): Promise<void> {
  const idx = (await list()).filter((c) => c.id !== id);
  await chrome.storage.local.set({ [K.convIndex]: idx });
  await chrome.storage.local.remove(key(id));
}

export async function removeAll(): Promise<void> {
  const idx = await list();
  await chrome.storage.local.remove([K.convIndex, K.convActive, ...idx.map((c) => key(c.id))]);
}

export async function activeId(): Promise<string | undefined> {
  const data = await chrome.storage.local.get(K.convActive);
  return data[K.convActive] as string | undefined;
}

export async function setActive(id: string | undefined): Promise<void> {
  if (id) await chrome.storage.local.set({ [K.convActive]: id });
  else await chrome.storage.local.remove(K.convActive);
}
