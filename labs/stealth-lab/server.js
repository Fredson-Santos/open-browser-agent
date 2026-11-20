// Laboratório local para testar o OBA em modo headless/stealth (Fase 4).
// Sem dependências — roda com: node server.js
// Bind fixo em 127.0.0.1, só para uso local.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 5960);
const HOST = "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
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

// ---------------------------------------------------------- avaliação
// Cada sinal de fingerprint pesa diferente. "webdriver" é o único que o
// script anti-webdriver do OBA (cdp.ts: STEALTH_INIT_SCRIPT) promete
// mascarar; os demais são informativos — o Chrome --headless=new moderno
// já não falha a maioria deles por padrão, mas servem de referência.
function evaluate(fp) {
  const signals = [];
  const flag = (name, bad, weight, note) => signals.push({ name, bad: Boolean(bad), weight, note });

  flag("navigator.webdriver", fp.webdriver === true, 5, "deveria ser false/undefined — é o único que o OBA promete mascarar em modo stealth");
  flag("User-Agent contém HeadlessChrome", /headlesschrome/i.test(fp.userAgent || ""), 4, "--headless=new moderno já não inclui isso por padrão");
  flag("window.chrome ausente", fp.hasChrome === false, 3, "extensões normais garantem window.chrome.runtime");
  flag("navigator.plugins vazio", (fp.pluginsLength ?? 0) === 0, 1, "comum em headless antigo, hoje é fraco sinal");
  flag("navigator.languages vazio", (fp.languagesLength ?? 1) === 0, 1, "sinal fraco, mas combinável");
  flag("outerWidth/Height zerados", fp.outerWidth === 0 && fp.outerHeight === 0, 2, "truque do headless clássico (pré --headless=new)");
  flag("WebGL renderer = SwiftShader", /swiftshader/i.test(fp.webglRenderer || ""), 1, "indica ausência de GPU real — comum em CI, não exclusivo de automação");

  const score = signals.reduce((s, x) => s + (x.bad ? x.weight : 0), 0);
  const maxScore = signals.reduce((s, x) => s + x.weight, 0);
  const automationLikely = score >= 5; // o peso do webdriver isolado já basta
  return { signals, score, maxScore, automationLikely };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ---------------------------------------------------------- cenário 1
  // POST /api/fingerprint — recebe os sinais coletados no browser e devolve
  // um veredito. Objetivo: rodar a página / com e sem --cybersec e comparar
  // "automationLikely" nas duas respostas.
  if (pathname === "/api/fingerprint" && req.method === "POST") {
    const fp = await readBody(req);
    const verdict = evaluate(fp);
    const body = { ...verdict };
    if (!verdict.automationLikely) {
      body.flag = "FLAG{stealth-fingerprint-clean}";
    }
    json(res, 200, body);
    return;
  }

  // ---------------------------------------------------------- utilitário
  // GET /api/whoami — eco de headers recebidos de fato (User-Agent real
  // enviado pela rede, Accept-Language, Sec-CH-UA, etc.).
  if (pathname === "/api/whoami" && req.method === "GET") {
    json(res, 200, { headers: req.headers });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Stealth Lab em http://${HOST}:${PORT}  (Ctrl+C para parar)`);
});
