// Service worker: mantém a conexão Native Messaging com o host `oba` e
// despacha as chamadas de ferramenta vindas dos agentes.
//
// Uma porta connectNative aberta mantém o service worker vivo (Chrome 105+),
// então não precisamos de offscreen keepalive neste transporte. O alarme só
// reconecta caso o host não esteja instalado/rodando.

import * as overlay from "./overlay";
import * as permissions from "./permissions";
import * as sessions from "./sessions";
import { type Decision, type HostState, K } from "./store";
import * as tools from "./tools";

const HOST = "com.oba.browser";
const VERSION = chrome.runtime.getManifest().version;

type HostMessage = {
  type: string;
  id?: string;
  session?: string;
  client?: string;
  tool?: string;
  args?: Record<string, unknown>;
  version?: string;
};

let port: chrome.runtime.Port | null = null;

/** Nome do navegador, para o agente poder escolher entre vários abertos. */
function browserName(): string {
  const nav = navigator as Navigator & {
    brave?: unknown;
    userAgentData?: { brands?: { brand: string }[] };
  };
  if (nav.brave) return "Brave";
  const brands = (nav.userAgentData?.brands ?? []).map((b) => b.brand);
  if (brands.some((b) => /brave/i.test(b))) return "Brave";
  if (brands.some((b) => /edge/i.test(b))) return "Edge";
  if (brands.some((b) => /opera/i.test(b))) return "Opera";
  if (brands.some((b) => /vivaldi/i.test(b))) return "Vivaldi";
  if (brands.some((b) => /google chrome/i.test(b))) return "Chrome";
  return "Chromium";
}

async function setStatus(connected: boolean, detail = ""): Promise<void> {
  chrome.action.setBadgeText({ text: connected ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#0e9f6e" : "#6b7280" });
  chrome.action.setTitle({ title: connected ? "OBA: conectado" : `OBA: desconectado${detail ? ` — ${detail}` : ""}` });
  const state: HostState = { connected, browser: browserName(), detail, since: Date.now() };
  await chrome.storage.session.set({ [K.host]: state });
}

function connect(): void {
  if (port) return;
  let p: chrome.runtime.Port;
  try {
    p = chrome.runtime.connectNative(HOST);
  } catch (e) {
    void setStatus(false, String(e));
    return;
  }
  port = p;
  let wasConnected = false;

  p.onMessage.addListener((msg: HostMessage) => {
    if (msg.type === "host_info") {
      wasConnected = true;
      void setStatus(true);
      void sessions.reset();
      return;
    }
    void handle(p, msg);
  });

  p.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? "";
    if (port === p) port = null;
    void setStatus(false, reason);
    console.warn("[OBA] host desconectado:", reason);
    // Se o host caiu depois de conectado, tenta logo; senão espera o alarme.
    if (wasConnected) setTimeout(connect, 2000);
  });

  p.postMessage({ type: "hello", version: VERSION, browser: browserName() });
}

async function handle(p: chrome.runtime.Port, msg: HostMessage): Promise<void> {
  switch (msg.type) {
    case "tool_request": {
      const ctx = { session: msg.session ?? "?", client: msg.client ?? "agente" };
      const result = await tools.run(msg.tool ?? "", ctx, msg.args ?? {});
      try {
        p.postMessage({ type: "tool_response", id: msg.id, result });
      } catch (e) {
        console.warn("[OBA] falha ao responder", msg.id, e);
      }
      break;
    }
    case "session_closed":
      if (msg.session) await sessions.close(msg.session);
      break;
  }
}

async function setStopped(session: string, stop: boolean): Promise<void> {
  if (stop) tools.abortSession(session);
  await sessions.setStopped(session, stop);
}

type UiMessage =
  | { type: "OBA_STOP" | "OBA_RESUME" }
  | { type: "OBA_DECIDE"; id: string; decision: Decision }
  | { type: "OBA_SESSION"; session: string; stop: boolean }
  | { type: "OBA_RECONNECT" };

// Mensagens do overlay (Parar/Retomar), da janela de aprovação e do side panel.
// onMessage só recebe mensagens da própria extensão; páginas web não chegam aqui.
chrome.runtime.onMessage.addListener((msg: UiMessage, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  void (async () => {
    switch (msg.type) {
      case "OBA_STOP":
      case "OBA_RESUME": {
        const found = sender.tab && (await sessions.byGroup(sender.tab.groupId));
        if (found) await setStopped(found[0], msg.type === "OBA_STOP");
        break;
      }
      case "OBA_DECIDE":
        await permissions.decide(msg.id, msg.decision);
        break;
      case "OBA_SESSION":
        await setStopped(msg.session, msg.stop);
        break;
      case "OBA_RECONNECT":
        connect();
        break;
    }
    reply({ ok: true });
  })();
  return true;
});

// Cada navegação apaga o overlay; recoloca nas abas que pertencem a um agente.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  void (async () => {
    const found = await sessions.byGroup(tab.groupId);
    if (found) await overlay.attach(tabId, found[1].client, { stopped: found[1].stopped });
  })();
});

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.alarms.create("oba-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "oba-reconnect") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

void setStatus(false);
connect();
