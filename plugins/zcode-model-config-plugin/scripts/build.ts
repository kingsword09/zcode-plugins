#!/usr/bin/env node
// Drive the Vite+ build() API from a plain script (vite-plus ships the `vp`
// CLI, but this build only needs the programmatic API).
import { build } from "vite-plus";

const mode = (process.argv[2] ?? "web") as "web" | "node";
if (mode !== "web" && mode !== "node") {
  console.error(`usage: bun scripts/build.ts <web|node> (got "${mode}")`);
  process.exit(2);
}

try {
  await build({
    mode,
    configFile: "vite.config.ts",
    logLevel: "info",
  });
  console.log(`[vite-plus] ${mode} build done`);
} catch (error) {
  console.error(`[vite-plus] ${mode} build failed:`, error);
  process.exit(1);
}
