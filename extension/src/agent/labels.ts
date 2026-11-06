// Descrição legível de cada chamada de ferramenta, para o bloco de ações do chat.

type Args = Record<string, unknown>;

const str = (v: unknown, max = 48): string => {
  if (typeof v !== "string" || !v) return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const quote = (v: unknown, max?: number) => (str(v, max) ? `“${str(v, max)}”` : "");
const host = (v: unknown): string => {
  if (typeof v !== "string") return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? str(u.pathname, 28) : "");
  } catch {
    return str(v);
  }
};
const join = (...parts: string[]) => parts.filter(Boolean).join(" ");

const COMPUTER: Record<string, string> = {
  left_click: "Clicar",
  right_click: "Clique com o botão direito",
  middle_click: "Clique com o botão do meio",
  double_click: "Clique duplo",
  triple_click: "Clique triplo",
  hover: "Passar o mouse",
  left_click_drag: "Arrastar",
  scroll_to: "Rolar até o elemento",
  screenshot: "Capturar a tela",
};

const SCROLL: Record<string, string> = { up: "para cima", down: "para baixo", left: "para a esquerda", right: "para a direita" };

export function describeTool(name: string, args: Args): string {
  switch (name) {
    case "tabs_context":
      return "Ver abas";
    case "tabs_create":
      return join("Abrir nova aba", host(args.url));
    case "tabs_close":
      return "Fechar aba";
    case "navigate": {
      const u = typeof args.url === "string" ? args.url.toLowerCase() : "";
      if (u === "back") return "Voltar página";
      if (u === "forward") return "Avançar página";
      if (u === "reload") return "Recarregar página";
      return join("Abrir", host(args.url));
    }
    case "screenshot":
      return "Capturar a tela";
    case "read_page":
      return args.filter === "interactive" ? "Ler elementos interativos" : "Ler estrutura da página";
    case "find":
      return join("Procurar", quote(args.query));
    case "get_page_text":
      return "Ler texto da página";
    case "computer": {
      const action = String(args.action ?? "");
      if (action === "type") return join("Digitar", quote(args.text, 36));
      if (action === "key") return join("Pressionar", str(args.text, 30));
      if (action === "scroll") return join("Rolar", SCROLL[String(args.scroll_direction)] ?? "");
      if (action === "wait") return `Aguardar ${typeof args.duration === "number" ? `${args.duration}s` : ""}`.trim();
      return COMPUTER[action] ?? join("Ação", action);
    }
    case "form_input": {
      const v = args.value;
      return join("Preencher campo", typeof v === "string" ? quote(v, 30) : typeof v === "boolean" ? (v ? "(marcar)" : "(desmarcar)") : "");
    }
    case "handle_dialog":
      return args.accept === false ? "Cancelar diálogo" : "Confirmar diálogo";
    case "read_console":
      return "Ler console";
    case "read_network":
      return "Ler requisições de rede";
    case "file_upload":
      return "Anexar arquivo";
    case "gif_creator":
      return join("Gravação GIF:", str(args.action));
    case "javascript":
      return "Executar JavaScript";
    default:
      return name;
  }
}
