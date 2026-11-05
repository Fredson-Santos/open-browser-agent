// Mouse e teclado nativos via CDP (eventos com isTrusted = true).

import * as cdp from "./cdp";

export type Button = "left" | "right" | "middle";

const BUTTON_MASK: Record<Button, number> = { left: 1, right: 2, middle: 4 };

async function mouse(tabId: number, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
}

export async function move(tabId: number, x: number, y: number): Promise<void> {
  await mouse(tabId, "mouseMoved", x, y);
}

export async function click(tabId: number, x: number, y: number, button: Button = "left", count = 1, modifiers = 0) {
  await move(tabId, x, y);
  for (let i = 1; i <= count; i++) {
    await mouse(tabId, "mousePressed", x, y, { button, buttons: BUTTON_MASK[button], clickCount: i, modifiers });
    await mouse(tabId, "mouseReleased", x, y, { button, buttons: 0, clickCount: i, modifiers });
  }
}

export async function drag(tabId: number, from: [number, number], to: [number, number]) {
  const [x0, y0] = from;
  const [x1, y1] = to;
  await move(tabId, x0, y0);
  await mouse(tabId, "mousePressed", x0, y0, { button: "left", buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    await mouse(tabId, "mouseMoved", x, y, { button: "left", buttons: 1 });
  }
  await mouse(tabId, "mouseReleased", x1, y1, { button: "left", buttons: 0, clickCount: 1 });
}

export async function wheel(tabId: number, x: number, y: number, deltaX: number, deltaY: number) {
  await mouse(tabId, "mouseWheel", x, y, { deltaX, deltaY });
}

export async function insertText(tabId: number, text: string) {
  await cdp.send(tabId, "Input.insertText", { text });
}

// ---------------------------------------------------------------- teclado

type KeyDef = { key: string; code: string; keyCode: number; text?: string };

const NAMED: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const MODIFIERS: Record<string, { bit: number; def: KeyDef }> = {
  alt: { bit: 1, def: { key: "Alt", code: "AltLeft", keyCode: 18 } },
  ctrl: { bit: 2, def: { key: "Control", code: "ControlLeft", keyCode: 17 } },
  control: { bit: 2, def: { key: "Control", code: "ControlLeft", keyCode: 17 } },
  meta: { bit: 4, def: { key: "Meta", code: "MetaLeft", keyCode: 91 } },
  cmd: { bit: 4, def: { key: "Meta", code: "MetaLeft", keyCode: 91 } },
  win: { bit: 4, def: { key: "Meta", code: "MetaLeft", keyCode: 91 } },
  shift: { bit: 8, def: { key: "Shift", code: "ShiftLeft", keyCode: 16 } },
};

function keyDef(name: string, shift: boolean): KeyDef {
  const named = NAMED[name.toLowerCase()];
  if (named) return named;
  if (name.length === 1) {
    const ch = name;
    const upper = ch.toUpperCase();
    if (/[a-z]/i.test(ch)) {
      const out = shift ? upper : ch.toLowerCase();
      return { key: out, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: out };
    }
    if (/[0-9]/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    return { key: ch, code: "", keyCode: 0, text: ch };
  }
  throw new Error(`tecla desconhecida: "${name}"`);
}

/** Pressiona um combo como "ctrl+a", "shift+Tab" ou "Enter". */
async function combo(tabId: number, spec: string) {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return;
  const keyName = parts.pop()!;
  let mods = 0;
  const held: KeyDef[] = [];
  for (const m of parts) {
    const mod = MODIFIERS[m.toLowerCase()];
    if (!mod) throw new Error(`modificador desconhecido: "${m}"`);
    mods |= mod.bit;
    held.push(mod.def);
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: mods, ...base(mod.def) });
  }
  const def = keyDef(keyName, (mods & 8) !== 0);
  // Com ctrl/alt/meta, a tecla não deve inserir texto.
  const typesText = def.text !== undefined && (mods & ~8) === 0;
  await cdp.send(tabId, "Input.dispatchKeyEvent", {
    type: typesText ? "keyDown" : "rawKeyDown",
    modifiers: mods,
    ...base(def),
    ...(typesText ? { text: def.text, unmodifiedText: def.text } : {}),
  });
  await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: mods, ...base(def) });
  for (const h of held.reverse()) {
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, ...base(h) });
  }
}

function base(d: KeyDef) {
  return { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
}

/** Sequência separada por espaços: "ctrl+a Delete", "Tab Tab Enter". */
export async function keys(tabId: number, spec: string, repeat = 1) {
  const seq = spec.trim().split(/\s+/).filter(Boolean);
  if (seq.length === 0) throw new Error("text é obrigatório para action=key (ex.: \"Enter\", \"ctrl+a\").");
  for (let r = 0; r < Math.max(1, Math.min(repeat, 100)); r++) {
    for (const k of seq) await combo(tabId, k);
  }
}
