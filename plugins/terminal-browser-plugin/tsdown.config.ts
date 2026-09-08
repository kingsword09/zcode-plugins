import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/mcp/server.ts", "src/mcp/recording-worker.ts"],
  format: "esm",
  target: "node24",
  outDir: "dist",
  // Keep the runtime path stable: plugin.json points at dist/mcp/server.js.
  outputOptions: {
    entryFileNames: "mcp/[name].js",
    exports: "named",
  },
  deps: {
    neverBundle: ["playwright-core"],
    alwaysBundle: [/^@modelcontextprotocol\/sdk/, /^@jsquash\//, /^mediabunny/, /^wasm-feature-detect/, /^zod/, /^pixelmatch/, /^pngjs/],
  },
  unbundle: false,
  dts: false,
  clean: true,
  platform: "node",
  shims: true,
  minify: true,
});
