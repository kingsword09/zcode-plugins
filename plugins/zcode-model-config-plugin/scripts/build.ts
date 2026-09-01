#!/usr/bin/env node
// Drive @voidzero-dev/vite-plus-core (the engine behind `vp`) from a plain script.
// vite-plus-core doesn't ship a `vp` CLI binary, so we call its `build()` API.
import { build } from "@voidzero-dev/vite-plus-core";

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
