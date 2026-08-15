import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { server: "src/mcp/server.ts" },
  outDir: "dist",
  outExtensions: () => ({ js: ".js" }),
  format: "esm",
  platform: "node",
  target: "node24",
  clean: true,
  dts: false,
  sourcemap: false,
  deps: {
    neverBundle: ["@modelcontextprotocol/sdk"],
    onlyBundle: false
  }
});
