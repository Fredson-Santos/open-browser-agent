# OBA Stealth Lab

Site local, sem dependências, para comparar o fingerprint de automação de uma
aba controlada pelo OBA **com** e **sem** o modo CyberSec/stealth
(`--cybersec` + `OBA_CYBERSEC=1`). Não acessa rede nenhuma — `http.createServer`
puro do Node, preso em `127.0.0.1`.

Isto não é um detector de bot "de verdade" (os sites reais usam sinais muito
mais sofisticados). É um alvo pequeno e determinístico para validar que o
`STEALTH_INIT_SCRIPT` do OBA (`extension/src/cdp.ts`) está sendo injetado e
fazendo efeito.

## Rodar

```
node server.js
```

Abre em `http://127.0.0.1:5960`. Porta configurável via `PORT=xxxx node server.js`.

## O que o scan mede

| Sinal | Peso | O que indica |
| --- | --- | --- |
| `navigator.webdriver` | 5 | **O único sinal que o OBA promete mascarar** em modo stealth (`cdp.ts: STEALTH_INIT_SCRIPT`) |
| User-Agent contém `HeadlessChrome` | 4 | Headless antigo vazava isso; `--headless=new` moderno não |
| `window.chrome` ausente | 3 | Extensões normais garantem `window.chrome.runtime`; o OBA também cria isso via script se faltar |
| `outerWidth`/`outerHeight` zerados | 2 | Truque do headless clássico (pré-`--headless=new`) |
| `navigator.plugins` vazio | 1 | Sinal fraco, comum até em Chrome normal sem plugins instalados |
| `navigator.languages` vazio | 1 | Sinal fraco |
| WebGL renderer = SwiftShader | 1 | Indica ausência de GPU real (comum em CI/VM, não exclusivo de automação) |

Score ≥ 5 (o peso do `webdriver` isolado já basta) marca `automationLikely: true`.
Score baixo devolve uma flag (`FLAG{stealth-fingerprint-clean}`) só pra ter um
alvo objetivo de "passou".

## Fluxo sugerido

1. Com o OBA em modo **normal** (sem `--cybersec`), abra esta página na aba
   controlada e clique "Rodar scan". Anote o resultado — é a linha de base.
2. Rode o OBA com `--cybersec` + `OBA_CYBERSEC=1` (depois de `oba install --cybersec`
   uma vez) e repita o scan na mesma página, numa aba nova.
3. Compare: `navigator.webdriver` deve mudar de sinal, já que é o único que o
   script injeta de propósito. Os demais sinais tendem a já estar "limpos" em
   `--headless=new` moderno mesmo sem stealth — não espere diferença neles.
4. Se quiser testar o modo headless de fato (`oba mcp --headless --cybersec`),
   repita o scan nessa instância e confira que o veredito continua limpo.

## Limite conhecido

O gate de aprovação (popups de pareamento/site) não é testável por esta
página — ele vive inteiramente do lado da extensão (`permissions.ts`), não
deixa rastro observável via JS da página. Para esse ponto, o teste é
comportamental: confirmar que **sem** `--cybersec` o OBA abre um popup de
aprovação na primeira chamada, e que **com** `--cybersec` ele não abre.
