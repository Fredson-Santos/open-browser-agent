# OBA CyberSec Lab

Site local, sem dependências, para testar a Fase 3 do OBA (`intercept_rules` e
`http_repeater`) contra alvos conhecidos. Não acessa rede nenhuma — é só
`http.createServer` puro do Node, preso em `127.0.0.1`.

## Rodar

```
node server.js
```

Abre em `http://127.0.0.1:5959`. Porta configurável via `PORT=xxxx node server.js`.

## Cenários e qual tool cada um exercita

| Rota | Comportamento real | O que testar |
| --- | --- | --- |
| `GET /api/profile` | Sempre devolve `"admin": false` | `intercept_rules` de **Response**, match & replace no body (`"admin":false` → `"admin":true`) |
| `GET /api/admin` | 403 a menos que o cookie `role=admin` esteja presente | `intercept_rules` trocando status `403 → 200`, **ou** a tool `cookies` (Fase 2) setando `role=admin` direto — compare os dois caminhos |
| `GET /api/internal` | 403 a menos que `X-Forwarded-For` pareça interno (`10.*`, `192.168.*`, `127.0.0.1`) | `intercept_rules` de **Request**, injetando o header antes do envio, **ou** `http_headers` (Fase 2) |
| `POST /api/login` | `guest/guest` → token sem privilégio; `admin/admin123` → token admin | capturar com `read_network`, base para o cenário 5 |
| `GET /api/secret` | Exige `Authorization: Bearer <token admin>`; token guest dá 403 | `http_repeater`: reemitir a requisição trocando o header `Authorization` pelo token admin |
| `GET /api/whoami` | Eco dos headers/cookies recebidos de fato | conferir o que realmente saiu da aba, depois de qualquer interceptação |
| `POST /api/reset` | Zera tokens/sessões em memória | reiniciar o estado do lab sem reiniciar o processo |

A página em `/` tem botões para cada rota e mostra a resposta crua, então dá
para acompanhar visualmente enquanto o OBA intercepta por baixo.

## Fluxo sugerido

1. Suba o OBA em modo cybersec (`--cybersec` + `OBA_CYBERSEC=1`) ou no modo
   normal, se só for testar `intercept_rules`/`http_repeater` sem o gate de
   headless/stealth.
2. Abra `http://127.0.0.1:5959` na aba controlada pelo OBA.
3. Clique em "Chamar /api/profile" uma vez sem regra nenhuma — confirme que
   vem `admin: false`.
4. Peça ao agente para criar a `intercept_rules` de Response e repita o
   clique — o painel "🔓 Painel de admin liberado" deve aparecer na página.
5. Repita para `/api/admin` (403→200) e `/api/internal` (header injetado).
6. Faça login como `guest`, capture a chamada com `read_network`, e use
   `http_repeater` para reemitir `/api/secret` com um token admin (obtido
   logando como `admin/admin123` em outra chamada).

Tudo isso é estado em memória do processo Node — reiniciar o servidor (ou
chamar `/api/reset`) limpa tokens e sessões.
