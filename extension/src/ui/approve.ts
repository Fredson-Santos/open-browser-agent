// Janela de aprovação: pareamento de agente ou acesso a um site.

import { type Decision, K, type Prompt } from "../store";

const id = new URLSearchParams(location.search).get("id") ?? "";
const $ = (sel: string) => document.getElementById(sel)!;

function el(tag: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}

async function main() {
  const data = await chrome.storage.session.get(K.pending);
  const prompt = (data[K.pending] as Record<string, Prompt> | undefined)?.[id];
  if (!prompt) {
    $("title").textContent = "Este pedido já foi respondido.";
    document.querySelector(".actions")!.remove();
    setTimeout(() => window.close(), 1200);
    return;
  }

  const title = $("title");
  title.textContent = "";
  if (prompt.kind === "client") {
    $("kicker").textContent = "Novo agente";
    title.append(el("b", prompt.client), " quer controlar este navegador");
    $("why").textContent =
      "Ele poderá abrir abas no próprio grupo, ler páginas e clicar ou digitar nelas. " +
      "Só aprove agentes que você mesmo iniciou.";
    $("always").textContent = "Permitir sempre";
    $("session").textContent = "Só desta vez";
    $("deny").textContent = "Recusar";
  } else {
    $("kicker").textContent = "Acesso a site";
    title.append(el("b", prompt.client), " quer acessar ", el("b", prompt.domain ?? "?"));
    $("why").textContent =
      "O agente poderá ler o conteúdo das páginas deste site e interagir com elas, " +
      "inclusive onde você estiver logado.";
    $("always").textContent = "Sempre permitir neste site";
    $("session").textContent = "Permitir agora";
    $("deny").textContent = "Bloquear site";
  }
  document.title = `OBA · ${prompt.kind === "client" ? prompt.client : prompt.domain}`;

  const send = (decision: Decision) => {
    for (const b of document.querySelectorAll("button")) b.disabled = true;
    chrome.runtime.sendMessage({ type: "OBA_DECIDE", id, decision }).finally(() => window.close());
  };
  $("always").addEventListener("click", () => send("always"));
  $("session").addEventListener("click", () => send("session"));
  $("deny").addEventListener("click", () => send("deny"));
  // Sem foco automático: um Enter acidental não deve conceder acesso.
}

void main();
