// Indicadores visuais nas abas controladas por um agente:
// borda luminosa, cursor fantasma, efeito de clique e pílula com Parar/Retomar.
//
// Tudo vive num Shadow DOM fechado com pointer-events: none — só o botão da
// pílula recebe cliques, e só cliques reais do usuário (isTrusted).

const STYLE = `
:host { all: initial; }
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.border {
  position: fixed; inset: 0; pointer-events: none;
  box-shadow: inset 0 0 0 2px rgba(34, 211, 238, .85), inset 0 0 22px 2px rgba(34, 211, 238, .25);
  transition: box-shadow .3s ease;
}
.busy .border { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse {
  50% { box-shadow: inset 0 0 0 3px rgba(34, 211, 238, 1), inset 0 0 40px 6px rgba(34, 211, 238, .45); }
}
.stopped .border { animation: none; box-shadow: inset 0 0 0 2px rgba(248, 113, 113, .9), inset 0 0 22px 2px rgba(248, 113, 113, .25); }

.pill {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  padding: 6px 6px 6px 14px; border-radius: 999px;
  background: rgba(15, 23, 42, .92); color: #f8fafc;
  font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .28);
  pointer-events: auto; user-select: none; white-space: nowrap;
  transition: opacity .2s ease;
}
.passthrough .pill { pointer-events: none; opacity: .35; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #22d3ee; flex: none; }
.busy .dot { animation: blink 1s ease-in-out infinite; }
.stopped .dot { background: #f87171; animation: none; }
@keyframes blink { 50% { opacity: .25; } }
button {
  all: unset; cursor: pointer; padding: 6px 14px; border-radius: 999px;
  background: #ef4444; color: #fff; font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
}
button:hover { filter: brightness(1.1); }
button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.stopped button { background: #16a34a; }

.cursor {
  position: fixed; left: 0; top: 0; width: 24px; height: 24px; pointer-events: none;
  transform: translate(var(--x), var(--y));
  transition: transform var(--d, 300ms) cubic-bezier(.2, 0, 0, 1), opacity .2s ease;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .35));
}
.ripple {
  position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%;
  border: 2px solid #22d3ee; pointer-events: none; animation: ripple .45s ease-out forwards;
}
@keyframes ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .busy .border, .busy .dot { animation: none; }
  .cursor { transition: none; }
  .ripple { display: none; }
}
`;

const CURSOR_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
  <path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.3 L18 13.3 Z"
        fill="#22d3ee" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

interface Overlay {
  show(client: string): void;
  hide(): void;
  unhide(): void;
  remove(): void;
  setBusy(busy: boolean): void;
  setStopped(stopped: boolean): void;
  setPassthrough(on: boolean): void;
  moveCursor(x: number, y: number): number;
  clickEffect(x: number, y: number): void;
}

function create(): Overlay {
  const host = document.createElement("oba-overlay");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${STYLE}</style>
    <div class="root">
      <div class="border"></div>
      <div class="cursor" style="--x:-40px;--y:-40px">${CURSOR_SVG}</div>
      <div class="pill" role="status">
        <span class="dot"></span><span class="label"></span><button type="button"></button>
      </div>
    </div>`;
  const root = shadow.querySelector(".root") as HTMLElement;
  const label = shadow.querySelector(".label") as HTMLElement;
  const button = shadow.querySelector("button") as HTMLButtonElement;
  const cursor = shadow.querySelector(".cursor") as HTMLElement;

  let client = "Agente";
  let stopped = false;
  let pos = { x: -40, y: -40 };

  const render = () => {
    root.classList.toggle("stopped", stopped);
    label.textContent = stopped ? `${client} foi pausado` : `${client} está controlando esta aba`;
    button.textContent = stopped ? "Retomar" : "Parar";
    button.setAttribute("aria-label", stopped ? `Retomar ${client}` : `Parar ${client}`);
  };

  button.addEventListener("click", (e) => {
    if (!e.isTrusted) return; // a página não pode acionar o botão por script
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: stopped ? "OBA_RESUME" : "OBA_STOP" }).catch(() => {});
  });

  const mount = () => {
    if (!host.isConnected) (document.documentElement ?? document.body).appendChild(host);
  };

  return {
    show(name) {
      client = name || "Agente";
      render();
      mount();
      host.style.display = "";
    },
    hide() {
      host.style.display = "none";
    },
    unhide() {
      host.style.display = "";
    },
    remove() {
      host.remove();
    },
    setBusy(busy) {
      root.classList.toggle("busy", busy);
    },
    setStopped(value) {
      stopped = value;
      if (stopped) root.classList.remove("busy");
      render();
    },
    setPassthrough(on) {
      root.classList.toggle("passthrough", on);
    },
    /** Anima o cursor até (x, y); retorna a duração em ms. */
    moveCursor(x, y) {
      mount();
      const from = pos.x < 0 ? { x: innerWidth / 2, y: innerHeight / 2 } : pos;
      if (pos.x < 0) {
        cursor.style.setProperty("--d", "0ms");
        cursor.style.setProperty("--x", `${from.x}px`);
        cursor.style.setProperty("--y", `${from.y}px`);
        void cursor.offsetWidth; // aplica a posição inicial antes da transição
      }
      const dist = Math.hypot(x - from.x, y - from.y);
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const d = reduce ? 0 : Math.round(Math.min(550, Math.max(160, dist * 0.6)));
      cursor.style.setProperty("--d", `${d}ms`);
      // A ponta da seta fica em (3, 2) dentro do SVG.
      cursor.style.setProperty("--x", `${x - 3}px`);
      cursor.style.setProperty("--y", `${y - 2}px`);
      pos = { x, y };
      return d;
    },
    clickEffect(x, y) {
      const r = document.createElement("div");
      r.className = "ripple";
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      root.appendChild(r);
      setTimeout(() => r.remove(), 500);
    },
  };
}

const w = window as unknown as { __obaOverlay?: Overlay };
if (!w.__obaOverlay) w.__obaOverlay = create();

export {};
