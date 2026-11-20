// Motor de percepção injetado na página (mundo isolado da extensão).
// Expõe window.__oba, chamado pelo service worker via chrome.scripting.
//
// - read_page: árvore compacta `role "nome" [ref_N]`, com redação de dados sensíveis
// - find: busca local por texto/role (sem LLM)
// - get_page_text: texto legível da página
// - resolveRef: ref → coordenadas na viewport (para cliques via CDP)
//
// Percorre shadow DOM aberto e iframes de mesma origem.

type Filter = "all" | "interactive";

interface ReadOptions {
  filter?: Filter;
  max_depth?: number;
  ref_id?: string;
  max_chars?: number;
}

// ---------------------------------------------------------------- refs

const refs = new Map<string, WeakRef<Element>>();
const ids = new WeakMap<Element, string>();
let counter = 0;

function refFor(el: Element): string {
  let id = ids.get(el);
  if (!id) {
    id = `ref_${++counter}`;
    ids.set(el, id);
    refs.set(id, new WeakRef(el));
  }
  return id;
}

function getRef(id: string): Element {
  const el = refs.get(id)?.deref();
  if (!el || !el.isConnected) {
    refs.delete(id);
    throw new Error(`${id} não encontrado ou expirou (a página mudou?). Chame read_page ou find de novo.`);
  }
  return el;
}

function pruneRefs(): void {
  for (const [id, ref] of refs) {
    const el = ref.deref();
    if (!el || !el.isConnected) refs.delete(id);
  }
}

// ---------------------------------------------------------------- semântica

const INTERACTIVE = new Set([
  "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
  "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "treeitem", "clickable",
]);

// Roles cujo nome vem do próprio texto (não repetimos o texto dos filhos).
const NAME_FROM_CONTENT = new Set([
  "link", "button", "heading", "option", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "treeitem", "switch", "cell", "columnheader", "rowheader", "clickable", "label",
]);

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "svg"]);

function implicitRole(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
    case "area":
      return el.hasAttribute("href") ? "link" : null;
    case "button":
    case "summary":
      return "button";
    case "input": {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "file") return "file";
      return "textbox";
    }
    case "select": {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? "listbox" : "combobox";
    }
    case "textarea":
      return "textbox";
    case "option":
      return "option";
    case "img":
      return "img";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return "heading";
    case "nav": return "navigation";
    case "main": return "main";
    case "header": return "banner";
    case "footer": return "contentinfo";
    case "aside": return "complementary";
    case "form": return "form";
    case "dialog": return "dialog";
    case "table": return "table";
    case "tr": return "row";
    case "td": return "cell";
    case "th": return "columnheader";
    case "ul": case "ol": return "list";
    case "li": return "listitem";
    case "iframe": case "frame": return "iframe";
    case "video": case "audio": return "media";
    case "label": return "label";
  }
  if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
  return null;
}

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
  return implicitRole(el);
}

function style(el: Element): CSSStyleDeclaration {
  return (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
}

/** Elemento sem role mas clicável (div com onclick, cursor: pointer, tabindex). */
function isClickableGeneric(el: Element): boolean {
  if (el.hasAttribute("onclick")) return true;
  const ti = el.getAttribute("tabindex");
  if (ti !== null && Number(ti) >= 0) return true;
  if (style(el).cursor !== "pointer") return false;
  const parent = el.parentElement;
  return !parent || style(parent).cursor !== "pointer"; // só o elemento mais externo
}

const FORM_CONTROLS = new Set(["input", "select", "textarea"]);

function isHidden(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return true;
  // Checkboxes/radios estilizados costumam esconder o <input> real com
  // opacity: 0 e desenhar outro elemento por cima; o controle continua usável.
  const checkOpacity = !FORM_CONTROLS.has(el.tagName.toLowerCase());
  const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
  if (anyEl.checkVisibility) {
    if (anyEl.checkVisibility({ checkOpacity, checkVisibilityCSS: true })) return false;
    return style(el).display !== "contents"; // display:contents não tem caixa, mas os filhos sim
  }
  const s = style(el);
  return s.display === "none" || s.visibility === "hidden" || (checkOpacity && s.opacity === "0");
}

/**
 * Texto acessível de um elemento: junta os nós de texto inserindo espaço nas
 * fronteiras de bloco (inclusive itens de flex/grid), para não gerar
 * "Ir para DashboardPágina" a partir de <span>Ir para Dashboard</span><span>Página</span>.
 */
function textOf(root: Element, limit = 300): string {
  let out = "";
  const visit = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (out.length > limit) return;
      if (c.nodeType === 3) {
        out += c.textContent ?? "";
      } else if (c.nodeType === 1) {
        const e = c as Element;
        const tag = e.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag) || e.getAttribute("aria-hidden") === "true") continue;
        // <label>Plano <select>…</select></label>: o nome é "Plano", sem as opções.
        if (FORM_CONTROLS.has(tag) || tag === "option" || tag === "datalist") continue;
        if (tag === "br") {
          out += " ";
          continue;
        }
        const d = style(e).display;
        if (d === "none") continue;
        const block = !d.startsWith("inline") && d !== "contents";
        if (block) out += " ";
        visit(e);
        if (block) out += " ";
      }
    }
  };
  visit(root);
  return out;
}

function isSensitive(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    // elementos de outros iframes têm outro HTMLInputElement; checa pela tag
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
  }
  const input = el as HTMLInputElement;
  if ((input.getAttribute("type") ?? "").toLowerCase() === "password") return true;
  const ac = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  if (/cc-|one-time-code|current-password|new-password/.test(ac)) return true;
  const hint = `${input.name ?? ""} ${input.id ?? ""}`.toLowerCase();
  return /(pass|senha|cvv|cvc|card.?num|cartao|otp|secret|token)/.test(hint);
}

const clean = (s: string | null | undefined, max = 120): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function textByIds(el: Element, attr: string): string {
  const list = el.getAttribute(attr);
  if (!list) return "";
  const doc = el.ownerDocument;
  return clean(list.split(/\s+/).map((id) => {
    const target = doc.getElementById(id);
    return target ? textOf(target) : "";
  }).join(" "));
}

function nameOf(el: Element, role: string | null): string {
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  const labelled = textByIds(el, "aria-labelledby");
  if (labelled) return labelled;

  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = clean(Array.from(labels).map((l) => textOf(l)).join(" "));
      if (t) return t;
    }
    const t = (el as HTMLInputElement).type;
    if (tag === "input" && ["button", "submit", "reset"].includes(t)) {
      return clean((el as HTMLInputElement).value) || t;
    }
    return clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || clean(el.getAttribute("name"));
  }
  if (tag === "img" || tag === "area") return clean(el.getAttribute("alt")) || clean(el.getAttribute("title"));
  if (tag === "iframe") return clean(el.getAttribute("title")) || clean(el.getAttribute("src"), 80);
  if (role && NAME_FROM_CONTENT.has(role)) {
    const t = clean(textOf(el));
    if (t) return t;
    const img = el.querySelector("img[alt]");
    if (img) return clean(img.getAttribute("alt"));
  }
  return clean(el.getAttribute("title"));
}

function extrasOf(el: Element, role: string | null): string {
  const parts: string[] = [];
  const tag = el.tagName.toLowerCase();
  if (role === "link") {
    const href = el.getAttribute("href");
    if (href && !href.startsWith("javascript:")) parts.push(`href="${clean(href, 100)}"`);
  }
  if (tag === "input" || tag === "textarea") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio") {
      parts.push(input.checked ? "(marcado)" : "(desmarcado)");
    } else if (input.value && !["button", "submit", "reset"].includes(input.type)) {
      parts.push(isSensitive(el) ? `value="[value redacted]"` : `value="${clean(input.value, 80)}"`);
    }
    if (input.type && !["text", "textarea", "checkbox", "radio", "submit", "button"].includes(input.type)) {
      parts.push(`type=${input.type}`);
    }
  } else if (tag === "select") {
    const s = el as HTMLSelectElement;
    const opt = s.options[s.selectedIndex];
    if (opt) parts.push(`value="${clean(opt.textContent, 80)}"`);
    // O menu nativo não aparece em screenshots: lista as opções aqui (use form_input).
    const opts = Array.from(s.options).map((o) => clean(o.textContent, 30)).filter(Boolean);
    if (opts.length) parts.push(`options=[${opts.slice(0, 20).join(" | ")}${opts.length > 20 ? ` | …+${opts.length - 20}` : ""}]`);
  } else if ((el as HTMLElement).isContentEditable && role === "textbox") {
    const t = clean(el.textContent, 80);
    if (t) parts.push(`value="${t}"`);
  }
  const checked = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed");
  if (checked === "true") parts.push("(marcado)");
  if (el.getAttribute("aria-expanded") === "true") parts.push("(expandido)");
  if (el.getAttribute("aria-selected") === "true") parts.push("(selecionado)");
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") parts.push("(desabilitado)");
  if (tag.match(/^h[1-6]$/)) parts.push(`level=${tag[1]}`);
  return parts.length ? " " + parts.join(" ") : "";
}

// ---------------------------------------------------------------- travessia

interface TreeNode {
  el: Element;
  role: string;
  name: string;
  depth: number;
  interactive: boolean;
}

interface WalkState {
  filter: Filter;
  maxDepth: number;
  deadline: number;
  timedOut: boolean;
  visit: (n: TreeNode) => boolean; // false = parar
  stopped: boolean;
  text: boolean; // emitir nós de texto (filtro "all")
}

/** Filhos na ordem do composed tree (shadow DOM aberto + slots + iframes). */
function childrenOf(el: Element): Element[] {
  const tag = el.tagName.toLowerCase();
  if (tag === "iframe" || tag === "frame") {
    try {
      const body = (el as HTMLIFrameElement).contentDocument?.body;
      return body ? [body] : [];
    } catch {
      return []; // cross-origin
    }
  }
  if (tag === "slot") {
    const assigned = (el as HTMLSlotElement).assignedElements({ flatten: true });
    return assigned.length ? assigned : Array.from(el.children);
  }
  if (el.shadowRoot) return Array.from(el.shadowRoot.children);
  return Array.from(el.children);
}

function walk(el: Element, depth: number, inNamed: boolean, st: WalkState): void {
  if (st.stopped) return;
  if (Date.now() > st.deadline) {
    st.timedOut = st.stopped = true;
    return;
  }
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) || isHidden(el)) return;

  let role = roleOf(el);
  if (!role && !inNamed && isClickableGeneric(el)) role = "clickable";
  const interactive = !!role && (INTERACTIVE.has(role) || role === "file");

  let printed = false;
  if (role && (st.filter === "all" ? role !== "label" : interactive)) {
    const name = nameOf(el, role);
    const isGenericLandmark = !name && !interactive && ["list", "listitem", "row", "cell", "form", "table"].includes(role);
    if (!isGenericLandmark) {
      if (!st.visit({ el, role, name, depth, interactive })) {
        st.stopped = true;
        return;
      }
      printed = true;
    }
  }

  if (st.text && !inNamed && !(role && NAME_FROM_CONTENT.has(role))) {
    // Texto solto direto neste elemento (parágrafos, spans etc.).
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        const t = clean(child.textContent, 200);
        if (t.length > 1 && !st.visit({ el, role: "text", name: t, depth: depth + (printed ? 1 : 0), interactive: false })) {
          st.stopped = true;
          return;
        }
      }
    }
  }

  const nextDepth = printed ? depth + 1 : depth;
  if (nextDepth > st.maxDepth) return;
  const named = inNamed || (!!role && NAME_FROM_CONTENT.has(role));
  for (const child of childrenOf(el)) walk(child, nextDepth, named, st);
}

/** Diálogo modal aberto no topo (o resto da página está inerte por trás dele). */
function activeModal(): Element | null {
  const candidates = Array.from(document.querySelectorAll('dialog, [aria-modal="true"]')).filter((e) => {
    if (e.tagName.toLowerCase() === "dialog" && !e.matches(":modal")) return false;
    return !isHidden(e);
  });
  return candidates.at(-1) ?? null;
}

function rootFor(refId?: string): Element {
  if (refId) return getRef(refId);
  return activeModal() ?? document.body ?? document.documentElement;
}

// ---------------------------------------------------------------- API

function readPage(opts: ReadOptions = {}): string {
  pruneRefs();
  const filter: Filter = opts.filter === "interactive" ? "interactive" : "all";
  const maxChars = opts.max_chars ?? 50_000;
  const lines: string[] = [];
  let size = 0;
  let truncated = false;

  const st: WalkState = {
    filter,
    maxDepth: opts.max_depth ?? 25,
    deadline: Date.now() + 1500,
    timedOut: false,
    stopped: false,
    text: filter === "all",
    visit(n) {
      const indent = filter === "interactive" ? "" : "  ".repeat(n.depth);
      const line = n.role === "text"
        ? `${indent}- text "${n.name}"`
        : `${indent}- ${n.role}${n.name ? ` "${n.name}"` : ""} [${refFor(n.el)}]${extrasOf(n.el, n.role)}`;
      if (size + line.length + 1 > maxChars) {
        truncated = true;
        return false;
      }
      lines.push(line);
      size += line.length + 1;
      return true;
    },
  };
  const root = rootFor(opts.ref_id);
  walk(root, 0, false, st);

  const modal = !opts.ref_id && root !== document.body && root !== document.documentElement;
  const header = `URL: ${location.href}\nTítulo: ${document.title}\nViewport: ${innerWidth}x${innerHeight}, scroll ${Math.round(scrollX)},${Math.round(scrollY)} de ${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}\n` +
    (modal ? `Modal aberto: mostrando só o diálogo "${nameOf(root, "dialog") || clean(textOf(root), 40)}" (o resto da página está bloqueado por trás dele).\n` : "");
  const notes: string[] = [];
  if (truncated) notes.push(`(saída truncada em ${maxChars} caracteres; use filter="interactive" ou ref_id para focar numa subárvore)`);
  if (st.timedOut) notes.push("(tempo limite de 1,5s atingido; árvore parcial)");
  if (lines.length === 0) notes.push("(nenhum elemento encontrado)");
  return header + "\n" + lines.join("\n") + (notes.length ? "\n\n" + notes.join("\n") : "");
}

const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const ROLE_WORDS: Record<string, string[]> = {
  button: ["botao", "button", "btn"],
  link: ["link", "hiperlink"],
  textbox: ["campo", "input", "caixa", "textbox", "texto", "field"],
  searchbox: ["busca", "pesquisa", "search", "procurar"],
  checkbox: ["checkbox", "caixa de selecao", "marcar"],
  combobox: ["dropdown", "select", "selecao", "combobox", "lista suspensa"],
  heading: ["titulo", "heading", "cabecalho"],
  img: ["imagem", "image", "img", "foto", "logo"],
  tab: ["aba", "tab"],
  menuitem: ["menu"],
};

const STOP_WORDS = new Set(["de", "da", "do", "das", "dos", "o", "a", "os", "as", "e", "em", "no", "na", "para", "com", "um", "uma", "the", "of", "to", "on", "in", "and"]);
const ALL_ROLE_WORDS = new Set(Object.values(ROLE_WORDS).flat().filter((w) => !w.includes(" ")));

/**
 * Pontuação: o texto da busca, sem as palavras de tipo ("botão", "link"…), é
 * comparado com o nome do elemento. Nome igual à frase > começa com ela >
 * contém a frase > cobre todas as palavras > cobre parte. As palavras de tipo
 * só desempatam: "botão mais resultados" acha o elemento "Mais resultados"
 * mesmo que ele seja uma div clicável e haja vários botões "Mais informações".
 */
function find(query: string, limit = 20): string {
  pruneRefs();
  const q = norm(query.trim());
  if (!q) throw new Error("query vazia.");
  const words = q.split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));
  // Palavras de tipo saem do texto, a menos que a busca seja só isso ("botão").
  const textWords = words.filter((w) => !ALL_ROLE_WORDS.has(w));
  const tokens = (textWords.length ? textWords : words).filter((t) => t.length > 1);
  const phrase = (textWords.length ? textWords : words).join(" ");
  const hits: { n: TreeNode; score: number }[] = [];
  const vw = innerWidth, vh = innerHeight;

  const st: WalkState = {
    filter: "all",
    maxDepth: 60,
    deadline: Date.now() + 1500,
    timedOut: false,
    stopped: false,
    text: false,
    visit(n) {
      const name = norm(n.name).trim();
      const hay = norm(`${n.name} ${n.el.getAttribute("placeholder") ?? ""} ${n.el.getAttribute("title") ?? ""} ${n.el.getAttribute("href") ?? ""} ${n.el.id}`);
      let score = 0;
      if (phrase && name) {
        if (name === phrase) score += 30;
        else if (name.startsWith(phrase)) score += 20;
        else if (name.includes(phrase)) score += 12;
      }
      const matched = tokens.filter((t) => hay.includes(t)).length;
      if (tokens.length) {
        if (matched === 0 && score === 0) {
          // Sem texto em comum: só serve se a busca for apenas o tipo ("campo de busca" → searchbox).
          if (textWords.length) return true;
        }
        score += matched === tokens.length ? 8 : 6 * (matched / tokens.length);
      }
      const roleWords = ROLE_WORDS[n.role] ?? [n.role];
      if (roleWords.some((w) => q.includes(w))) score += 3;
      if (score === 0) return true;
      if (n.interactive) score += 1;
      // Nomes enormes (cards inteiros clicáveis) contêm tudo; preferir o elemento mais específico.
      if (name.length > 80) score -= 2;
      const r = n.el.getBoundingClientRect();
      if (r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw) score += 1;
      hits.push({ n, score });
      return true;
    },
  };
  walk(rootFor(), 0, false, st);

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);
  if (top.length === 0) return `Nenhum elemento corresponde a "${query}". Tente read_page.`;
  const lines = top.map(({ n }) => `- ${n.role}${n.name ? ` "${n.name}"` : ""} [${refFor(n.el)}]${extrasOf(n.el, n.role)}`);
  return `${top.length} de ${hits.length} resultado(s) para "${query}":\n` + lines.join("\n") +
    (st.timedOut ? "\n(busca parcial: tempo limite atingido)" : "");
}

interface TextOptions {
  max_chars?: number;
  offset?: number;
  ref_id?: string;
}

/** Visível para quem olha a tela (diferente de isHidden, ignora aria-hidden: o texto aparece). */
function isVisibleBox(el: Element): boolean {
  const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
  if (anyEl.checkVisibility) return anyEl.checkVisibility({ checkVisibilityCSS: true }) || style(el).display === "contents";
  const s = style(el);
  return s.display !== "none" && s.visibility !== "hidden";
}

/** Imagem que transmite informação (logo da locadora, ícone de companhia aérea…), não decoração. */
function imageLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  let label = "";
  if (tag === "img" || (tag === "input" && (el as HTMLInputElement).type === "image")) label = el.getAttribute("alt") || el.getAttribute("title") || "";
  else if (tag === "svg" || role === "img") label = el.getAttribute("aria-label") || el.querySelector(":scope > title")?.textContent || "";
  label = clean(label, 80);
  if (!label) return "";
  const r = el.getBoundingClientRect();
  return r.width >= 12 || r.height >= 12 ? label : "";
}

/**
 * Texto da página na ordem visual, como o innerText, mas incluindo o texto
 * alternativo de imagens ("[img: Localiza]"), shadow DOM aberto e iframes de
 * mesma origem. Campos de formulário ficam de fora (use read_page).
 */
function collectText(root: Element, deadline: number): string | null {
  const out: string[] = [];
  let timedOut = false;
  const visit = (el: Element) => {
    if (timedOut) return;
    if (Date.now() > deadline) {
      timedOut = true;
      return;
    }
    const tag = el.tagName.toLowerCase();
    const img = imageLabel(el);
    if (img) {
      out.push(` [img: ${img}] `);
      return;
    }
    if (SKIP_TAGS.has(tag) || FORM_CONTROLS.has(tag) || tag === "option") return;
    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (!isVisibleBox(el)) return;
    const s = style(el);
    const d = s.display;
    const block = !d.startsWith("inline") && d !== "contents" && d !== "table-cell";
    const pre = s.whiteSpace.startsWith("pre");
    if (block) out.push("\n");
    if (el.shadowRoot || tag === "slot" || tag === "iframe" || tag === "frame") {
      for (const c of childrenOf(el)) visit(c);
    } else {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3) {
          const t = n.textContent ?? "";
          out.push(pre ? t : t.replace(/\s+/g, " "));
        } else if (n.nodeType === 1) {
          visit(n as Element);
        }
      }
    }
    if (d === "table-cell") out.push("\t");
    else if (block) out.push("\n");
  };
  visit(root);
  if (timedOut) return null;
  return out.join("")
    .replace(/[  ]*\t[ \t ]*/g, "\t")
    .replace(/[  ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\t+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageText(opts: TextOptions = {}): string {
  const maxChars = Math.max(1000, opts.max_chars ?? 50_000);
  const offset = Math.max(0, opts.offset ?? 0);
  const deadline = Date.now() + 2500;
  let root: Element;
  let text: string | null = null;
  if (opts.ref_id) {
    root = getRef(opts.ref_id);
    text = collectText(root, deadline);
  } else {
    // Prioriza <article>/<main> quando têm conteúdo de verdade.
    root = document.body ?? document.documentElement;
    for (const c of [document.querySelector("article"), document.querySelector("main")]) {
      if (!c) continue;
      const t = collectText(c, deadline);
      if (t && t.length > 500) {
        root = c;
        text = t;
        break;
      }
    }
    text ??= collectText(root, deadline);
  }
  const fallback = text === null;
  if (text === null) {
    text = ((root as HTMLElement).innerText ?? root.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  const total = text.length;
  const slice = text.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  const notes: string[] = [];
  if (offset > 0 || end < total) notes.push(`(caracteres ${offset}–${end} de ${total}${end < total ? `; continue com offset=${end}` : ""})`);
  if (fallback) notes.push("(página grande: texto simples, sem o texto das imagens)");
  const scope = opts.ref_id ? `Escopo: ${opts.ref_id}\n` : "";
  return `URL: ${location.href}\nTítulo: ${document.title}\n${scope}\n${slice}${notes.length ? "\n\n" + notes.join("\n") : ""}`;
}

/** Estado da página para wait_for: o texto (normalizado) aparece? */
function hasText(query: string): boolean {
  const q = norm(query).replace(/\s+/g, " ").trim();
  if (!q) return false;
  const body = document.body;
  if (!body) return false;
  const docs = [body.innerText];
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    try {
      const t = (f as HTMLIFrameElement).contentDocument?.body?.innerText;
      if (t) docs.push(t);
    } catch {
      /* outra origem */
    }
  }
  return docs.some((t) => norm(t).replace(/\s+/g, " ").includes(q));
}

interface Point {
  x: number;
  y: number;
  width: number;
  height: number;
  covered_by?: string;
  in_viewport: boolean;
}

/** Converte um ref em coordenadas CSS da viewport principal (somando iframes). */
function resolveRef(refId: string, scroll = true): Point {
  let el = getRef(refId);
  // <input> escondido (opacity 0 / 1px) de um checkbox estilizado: clicar no rótulo visível.
  const labels = (el as HTMLInputElement).labels;
  if (FORM_CONTROLS.has(el.tagName.toLowerCase()) && labels?.length) {
    const box = el.getBoundingClientRect();
    if (style(el).opacity === "0" || box.width < 4 || box.height < 4) el = labels[0];
  }
  if (scroll) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) throw new Error(`${refId} não tem área visível.`);
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;

  let win: Window | null = el.ownerDocument.defaultView;
  while (win && win !== window && win.frameElement) {
    const fr = win.frameElement.getBoundingClientRect();
    const fs = getComputedStyle(win.frameElement);
    x += fr.left + parseFloat(fs.borderLeftWidth) + parseFloat(fs.paddingLeft);
    y += fr.top + parseFloat(fs.borderTopWidth) + parseFloat(fs.paddingTop);
    win = win.parent;
  }

  const p: Point = { x: Math.round(x), y: Math.round(y), width: Math.round(r.width), height: Math.round(r.height), in_viewport: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight };
  if (el.ownerDocument === document) {
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      p.covered_by = `${top.tagName.toLowerCase()}${top.id ? "#" + top.id : ""}${top.className && typeof top.className === "string" ? "." + top.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`;
    }
  }
  return p;
}

function viewport() {
  return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) };
}

// ---------------------------------------------------------------- formulários

/** Define value pelo setter nativo e dispara input/change (funciona com React/Vue). */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const win = (el.ownerDocument.defaultView ?? window) as unknown as Record<string, { prototype: object }>;
  const ctor = el.tagName === "TEXTAREA" ? "HTMLTextAreaElement" : el.tagName === "SELECT" ? "HTMLSelectElement" : "HTMLInputElement";
  const setter = Object.getOwnPropertyDescriptor(win[ctor].prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const truthy = (v: unknown) => v === true || /^(true|1|sim|yes|on|marcado|checked)$/i.test(String(v).trim());

function formInput(refId: string, value: unknown): string {
  const el = getRef(refId);
  const tag = el.tagName.toLowerCase();
  (el as HTMLElement).focus?.();

  if (tag === "select") {
    const s = el as HTMLSelectElement;
    const raw = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim());
    const wanted = raw.map(norm);
    const match = (o: HTMLOptionElement, w: string) => norm(o.value) === w || norm(clean(o.textContent)) === w;
    const fuzzy = (o: HTMLOptionElement, w: string) => norm(clean(o.textContent)).includes(w);
    const options = Array.from(s.options);
    const picked = wanted.map((w) => options.find((o) => match(o, w)) ?? options.find((o) => fuzzy(o, w)));
    const missing = raw.filter((_, i) => !picked[i]);
    if (missing.length) {
      throw new Error(`opção não encontrada: ${missing.join(", ")}. Opções: ${options.map((o) => clean(o.textContent, 30)).join(" | ")}`);
    }
    if (s.multiple) {
      for (const o of options) o.selected = picked.includes(o);
      s.dispatchEvent(new Event("input", { bubbles: true }));
      s.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      setNativeValue(s, picked[0]!.value);
    }
    return `${refId} (select) agora: ${Array.from(s.selectedOptions).map((o) => `"${clean(o.textContent)}"`).join(", ")}`;
  }

  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio") {
      const want = truthy(value);
      if (input.checked !== want) {
        if (input.type === "radio" && !want) throw new Error("não dá para desmarcar um radio; marque outra opção do grupo.");
        input.click(); // dispara os eventos que frameworks esperam
      }
      return `${refId} (${input.type}) agora: ${input.checked ? "marcado" : "desmarcado"}`;
    }
    if (input.type === "file") throw new Error("para campos de arquivo use file_upload.");
    setNativeValue(input, String(value ?? ""));
    return `${refId} agora: ${isSensitive(input) ? "[value redacted]" : `"${clean(input.value, 80)}"`}`;
  }

  if (tag === "textarea") {
    setNativeValue(el as HTMLTextAreaElement, String(value ?? ""));
    return `${refId} (textarea) agora tem ${(el as HTMLTextAreaElement).value.length} caractere(s)`;
  }

  if ((el as HTMLElement).isContentEditable) {
    el.textContent = String(value ?? "");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    return `${refId} (editável) atualizado`;
  }

  throw new Error(`${refId} (${roleOf(el) ?? tag}) não é um campo de formulário; use computer (clique/digitação).`);
}

/** Marca o <input type=file> do ref para o CDP encontrá-lo no mundo principal. */
function markUpload(refId: string): { token: string; multiple: boolean; accept: string } {
  let el: Element | null = getRef(refId);
  const isFile = (e: Element | null) => !!e && e.tagName.toLowerCase() === "input" && (e as HTMLInputElement).type === "file";
  if (!isFile(el)) {
    // Botões/rótulos "Enviar arquivo" costumam envolver ou apontar para o input real.
    const viaLabel = (el as HTMLLabelElement).control ?? null;
    el = isFile(viaLabel) ? viaLabel : el!.querySelector('input[type="file"]') ?? el!.parentElement?.querySelector('input[type="file"]') ?? null;
  }
  if (!el || !isFile(el)) throw new Error(`${refId} não é (nem contém) um campo de arquivo <input type="file">.`);
  const token = `oba-${Math.random().toString(36).slice(2)}`;
  el.setAttribute("data-oba-upload", token);
  const input = el as HTMLInputElement;
  return { token, multiple: input.multiple, accept: input.accept };
}

(window as unknown as { __oba: unknown }).__oba = { readPage, find, pageText, hasText, resolveRef, viewport, formInput, markUpload };

export {};
