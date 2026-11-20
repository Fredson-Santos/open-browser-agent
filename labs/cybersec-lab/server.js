// Laboratório local para testar o OBA em modo CyberSec (Fase 3).
// Sem dependências — roda com: node server.js
// Bind fixo em 127.0.0.1, só para uso local.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 5959);
const HOST = "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

// --------------------------------------------------------------- "banco"
const tokens = new Map(); // token -> { user, role }
const sessions = new Map(); // sid -> { user, role }

function newId() {
  return crypto.randomBytes(16).toString("hex");
}

function json(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(req, res, urlPath) {
  const relPath = urlPath === "/" ? "index.html" : urlPath;
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(PUBLIC_DIR, safePath);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("não encontrado");
      return;
    }
    const ext = path.extname(file);
    const type =
      { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript" }[ext] ||
      "text/plain";
    res.writeHead(200, { "Content-Type": type }).end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const cookies = parseCookies(req);

  // ---------------------------------------------------------- cenário 1
  // GET /api/profile — sempre devolve admin:false no corpo real.
  // Objetivo: usar intercept_rules para reescrever o body da RESPOSTA
  // ("admin":false -> "admin":true), sem tocar em cookie nem servidor.
  if (pathname === "/api/profile" && req.method === "GET") {
    const sid = cookies.sid;
    const session = sid ? sessions.get(sid) : undefined;
    json(res, 200, {
      user: session?.user ?? "guest",
      role: session?.role ?? "guest",
      admin: false, // propositalmente sempre false — só muda via interceptação
      note: "Este campo é sempre false no servidor. Vire-o para true com intercept_rules (match&replace no response body).",
    });
    return;
  }

  // ---------------------------------------------------------- cenário 2
  // GET /api/admin — 403 a menos que o cookie "role" (legível/editável
  // pelo cliente) seja "admin". Objetivo: trocar 403 -> 200 via
  // intercept_rules, OU setar o cookie direto com a tool `cookies` (Fase 2).
  if (pathname === "/api/admin" && req.method === "GET") {
    if (cookies.role === "admin") {
      json(res, 200, { secret: "FLAG{admin-cookie-ou-intercept-200}" });
    } else {
      json(res, 403, { error: "forbidden", hint: "role atual: " + (cookies.role ?? "guest") });
    }
    return;
  }

  // ---------------------------------------------------------- cenário 3
  // GET /api/internal — simula um "WAF" que só libera requisições que
  // pareçam vir de rede interna. Objetivo: adicionar o header
  // X-Forwarded-For via intercept_rules (ou via http_headers, Fase 2).
  if (pathname === "/api/internal" && req.method === "GET") {
    const xff = req.headers["x-forwarded-for"] || "";
    const internal = /^(10\.|127\.0\.0\.1|192\.168\.)/.test(xff);
    if (internal) {
      json(res, 200, { secret: "FLAG{internal-network-bypassed}", via: xff });
    } else {
      json(res, 403, { error: "blocked by WAF", hint: "requisição não parece vir da rede interna" });
    }
    return;
  }

  // ---------------------------------------------------------- cenário 4
  // POST /api/login — gera um token. Objetivo: capturar esta troca com
  // read_network, depois usar http_repeater para reenviar /api/secret
  // mudando apenas o header Authorization pelo token capturado.
  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const user = String(body.username ?? "");
    const pass = String(body.password ?? "");
    if (user === "admin" && pass === "admin123") {
      const token = newId();
      const sid = newId();
      tokens.set(token, { user, role: "admin" });
      sessions.set(sid, { user, role: "admin" });
      json(res, 200, { token, user, role: "admin" }, {
        "Set-Cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`,
      });
    } else if (user === "guest" && pass === "guest") {
      const token = newId();
      const sid = newId();
      tokens.set(token, { user, role: "guest" });
      sessions.set(sid, { user, role: "guest" });
      json(res, 200, { token, user, role: "guest" }, {
        "Set-Cookie": `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`,
      });
    } else {
      json(res, 401, { error: "credenciais inválidas", hint: "tente guest/guest" });
    }
    return;
  }

  // ---------------------------------------------------------- cenário 5
  // GET /api/secret — exige "Authorization: Bearer <token>" de um
  // usuário admin. Um token "guest" dá 403. Objetivo: usar
  // http_repeater para reemitir a requisição trocando o token guest
  // pelo token admin capturado em outra chamada (ou via intercept_rules
  // de Request, reescrevendo o header antes de sair).
  if (pathname === "/api/secret" && req.method === "GET") {
    const auth = req.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const info = m ? tokens.get(m[1]) : undefined;
    if (!info) {
      json(res, 401, { error: "token ausente ou inválido" });
    } else if (info.role !== "admin") {
      json(res, 403, { error: "forbidden", role: info.role });
    } else {
      json(res, 200, { secret: "FLAG{repeater-privilege-escalation}", user: info.user });
    }
    return;
  }

  // ---------------------------------------------------------- utilitário
  // GET /api/whoami — eco de headers/cookies recebidos de fato (útil
  // para checar o que a Fase 2 e a Fase 3 estão realmente enviando).
  if (pathname === "/api/whoami" && req.method === "GET") {
    json(res, 200, {
      headers: req.headers,
      cookies,
    });
    return;
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    tokens.clear();
    sessions.clear();
    json(res, 200, { ok: true });
    return;
  }

  // ---------------------------------------------------------- estático
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`CyberSec Lab em http://${HOST}:${PORT}  (Ctrl+C para parar)`);
});
