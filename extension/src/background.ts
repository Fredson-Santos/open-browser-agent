// Service worker: mantém a conexão Native Messaging com o host `oba` e
// despacha as chamadas de ferramenta vindas dos agentes.
//
// Uma porta connectNative aberta mantém o service worker vivo (Chrome 105+),
// então não precisamos de offscreen keepalive neste transporte. O alarme só
// reconecta caso o host não esteja instalado/rodando.

import * as sessions from "./sessions";
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

function setStatus(connected: boolean, detail = ""): void {
  chrome.action.setBadgeText({ text: connected ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#0e9f6e" : "#6b7280" });
  chrome.action.setTitle({ title: connected ? "OBA: conectado ao host" : `OBA: desconectado${detail ? ` — ${detail}` : ""}` });
}

function connect(): void {
  if (port) return;
  let p: chrome.runtime.Port;
  try {
    p = chrome.runtime.connectNative(HOST);
  } catch (e) {
    setStatus(false, String(e));
    return;
  }
  port = p;
  let wasConnected = false;

  p.onMessage.addListener((msg: HostMessage) => {
    if (msg.type === "host_info") {
      wasConnected = true;
      setStatus(true);
      void sessions.reset();
      return;
    }
    void handle(p, msg);
  });

  p.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? "";
    if (port === p) port = null;
    setStatus(false, reason);
    console.warn("[OBA] host desconectado:", reason);
    // Se o host caiu depois de conectado, tenta logo; senão espera o alarme.
    if (wasConnected) setTimeout(connect, 2000);
  });

  p.postMessage({ type: "hello", version: VERSION });
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

chrome.alarms.create("oba-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "oba-reconnect") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(() => {
  if (!port) connect();
});

setStatus(false);
connect();
