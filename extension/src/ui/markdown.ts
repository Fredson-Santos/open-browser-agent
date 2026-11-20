// Markdown mínimo para as respostas do modelo. O texto pode trazer conteúdo
// de páginas (inclusive tentativas de injeção), então tudo é escapado antes e
// só geramos as tags abaixo; links aceitam apenas http(s).
//
// Suporta: blocos ``` , `código`, **negrito**, *itálico*, [links](https://…),
// URLs soltas, títulos (#), listas (-, *, 1.), citações (>), tabelas (| a | b |)
// e parágrafos.

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function inline(s: string): string {
  const codes: string[] = [];
  let out = escape(s).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

// ---------------------------------------------------------------- tabelas

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** Valor numérico, de moeda, hora ou porcentagem: alinhado à direita com algarismos de largura fixa. */
const NUMERIC = /^[~≈+−-]?\s*(R\$|US\$|\$|€|£)?\s*[\d.,:]+\s*(%|h|min|km|kg)?$/i;
const MONEY = /(R\$|US\$|\$|€|£)\s*\d/;

/** Divide uma linha "| a | b |" em células (aceita \| dentro da célula). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (body[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += body[i];
    }
  }
  out.push(cur.trim());
  return out;
}

const isTableStart = (lines: string[], i: number) =>
  lines[i].includes("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes("-");

/** Texto puro de uma célula do cabeçalho, para o rótulo do modo empilhado. */
const plain = (s: string) => escape(s.replace(/[*_`]/g, ""));

function table(lines: string[]): string {
  const head = cells(lines[0]);
  const align = cells(lines[1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
  const rows = lines.slice(2).map(cells);
  const n = head.length;
  // Colunas só de números/preços ficam à direita; as de preço ganham destaque.
  const kind = head.map((_, c) => {
    const values = rows.map((r) => (r[c] ?? "").replace(/[*_]/g, "")).filter(Boolean);
    if (values.length === 0 || !values.every((v) => NUMERIC.test(v))) return "";
    return values.some((v) => MONEY.test(v)) ? "num money" : "num";
  });
  const cls = (c: number) => {
    const list = [kind[c], align[c] ? `align-${align[c]}` : ""].filter(Boolean).join(" ");
    return list ? ` class="${list}"` : "";
  };
  const th = head.map((h, c) => `<th${cls(c)}>${inline(h)}</th>`).join("");
  const tr = rows
    .map((r) => {
      const tds = Array.from({ length: n }, (_, c) => `<td data-label="${plain(head[c])}"${cls(c)}>${inline(r[c] ?? "")}</td>`);
      return `<tr>${tds.join("")}</tr>`;
    })
    .join("");
  // "wide": com 4+ colunas, num painel estreito cada linha vira um bloco rótulo/valor.
  return `<div class="md-table${n >= 4 ? " wide" : ""}"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

export function toHtml(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) html.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      html.push(`<pre><code>${escape(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      flush();
      const block = [lines[i], lines[i + 1]];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) block.push(lines[i]);
      html.push(table(block));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      html.push(`<h4>${inline(heading[2])}</h4>`);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</li>`);
        i++;
      }
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
    i++;
  }
  flush();
  return html.join("");
}
