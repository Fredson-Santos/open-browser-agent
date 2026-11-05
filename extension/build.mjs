// Gera dist/ (pasta para "Carregar sem compactação" no navegador).
import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });
cpSync("manifest.json", "dist/manifest.json");

const options = {
  entryPoints: { background: "src/background.ts" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
