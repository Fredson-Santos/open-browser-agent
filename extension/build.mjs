// Gera dist/ (pasta para "Carregar sem compactação" no navegador).
import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });
cpSync("manifest.json", "dist/manifest.json");

const common = { outdir: "dist", bundle: true, target: "chrome116", sourcemap: true, logLevel: "info" };

const builds = [
  // service worker (módulo ES)
  { ...common, entryPoints: { background: "src/background.ts" }, format: "esm" },
  // motor injetado na página via chrome.scripting (script clássico)
  { ...common, entryPoints: { content: "src/content/index.ts" }, format: "iife" },
];

if (watch) {
  for (const b of builds) await (await context(b)).watch();
} else {
  await Promise.all(builds.map((b) => build(b)));
}
