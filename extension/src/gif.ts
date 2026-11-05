// Gravação de GIF das ações do agente: um quadro após cada ação, com o ponto
// do clique e uma legenda. Exporta para a pasta Downloads/oba.

import { GIFEncoder, applyPalette, quantize } from "gifenc";

type Frame = { data: string; mime: string; t: number; label: string; point?: { x: number; y: number }; cssWidth: number };

const MAX_FRAMES = 120;
const MAX_WIDTH = 800;
const recording = new Set<number>();
const frames = new Map<number, Frame[]>();

export const isRecording = (tabId: number) => recording.has(tabId);
export const frameCount = (tabId: number) => frames.get(tabId)?.length ?? 0;

export function start(tabId: number): void {
  recording.add(tabId);
  if (!frames.has(tabId)) frames.set(tabId, []);
}

export function stop(tabId: number): void {
  recording.delete(tabId);
}

export function clear(tabId: number): void {
  frames.delete(tabId);
}

export function addFrame(tabId: number, shot: { data: string; mime: string; width: number }, label: string, point?: { x: number; y: number }): void {
  if (!recording.has(tabId)) return;
  const list = frames.get(tabId) ?? [];
  list.push({ data: shot.data, mime: shot.mime, t: Date.now(), label, point, cssWidth: shot.width });
  if (list.length > MAX_FRAMES) list.splice(0, list.length - MAX_FRAMES);
  frames.set(tabId, list);
}

function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function drawOverlay(ctx: OffscreenCanvasRenderingContext2D, f: Frame, w: number, h: number, scale: number) {
  if (f.point) {
    const x = f.point.x * scale;
    const y = f.point.y * scale;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#22d3ee";
    ctx.fillStyle = "rgba(34, 211, 238, 0.25)";
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (f.label) {
    const bar = 26;
    ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
    ctx.fillRect(0, h - bar, w, bar);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(f.label.length > 90 ? f.label.slice(0, 89) + "…" : f.label, 10, h - bar / 2);
  }
}

/** Codifica os quadros e salva em Downloads/oba/. Retorna o caminho do arquivo. */
export async function exportGif(tabId: number, name?: string): Promise<{ path: string; frames: number; kb: number }> {
  const list = frames.get(tabId) ?? [];
  if (list.length === 0) throw new Error("nenhum quadro gravado. Use gif_creator action=start e faça algumas ações.");

  const gif = GIFEncoder();
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const bmp = await createImageBitmap(b64ToBlob(f.data, f.mime));
    const scale = Math.min(1, MAX_WIDTH / bmp.width);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, w, h);
    drawOverlay(ctx, f, w, h, (bmp.width / f.cssWidth) * scale);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    const next = list[i + 1];
    const delay = next ? Math.min(2000, Math.max(600, next.t - f.t)) : 2500;
    gif.writeFrame(index, w, h, { palette, delay });
  }
  gif.finish();
  const bytes = gif.bytes();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = (name ?? "").replace(/[^\w.-]+/g, "_").replace(/\.gif$/i, "");
  const filename = `oba/${safe || `oba-${stamp}`}.gif`;
  const id = await chrome.downloads.download({ url: `data:image/gif;base64,${bytesToB64(bytes)}`, filename, saveAs: false, conflictAction: "uniquify" });

  // Espera o download terminar para devolver o caminho final.
  for (let i = 0; i < 50; i++) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === "complete") return { path: item.filename, frames: list.length, kb: Math.round(bytes.length / 1024) };
    if (item?.state === "interrupted") throw new Error(`download interrompido: ${item.error}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { path: `Downloads/${filename}`, frames: list.length, kb: Math.round(bytes.length / 1024) };
}
