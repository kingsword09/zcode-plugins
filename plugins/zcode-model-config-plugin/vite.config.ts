import { defineConfig } from "@voidzero-dev/vite-plus-core";
import * as path from "node:path";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";
import { inlineAssetsPlugin } from "./scripts/vite-inline-assets.ts";

export default defineConfig(({ mode }) => {
  const isWeb = mode === "web";
  const isNode = mode === "node";

  return {
    plugins: [
      stylex.vite({
        useCSSLayers: true,
        unstable_moduleResolution: { type: "commonJS", rootDir: "web" },
        dev: false,
      }),
      react(),
      isWeb && inlineAssetsPlugin({ outPath: "src/ui/assets.ts", webOutDir: ".cache/web" }),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@shared": path.resolve("src/shared"),
      },
    },
    define: {
      // React (and some deps) branch on process.env.NODE_ENV at module-eval time.
      // The browser has no `process` global, so replace it statically.
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: isWeb
      ? {
          lib: {
            entry: path.resolve("web/main.tsx"),
            formats: ["iife"],
            name: "ZCodeModelConfig",
            fileName: () => "main.js",
          },
          outDir: ".cache/web",
          emptyOutDir: true,
          cssCodeSplit: false,
          sourcemap: false,
          minify: "esbuild",
          assetsInlineLimit: 0,
        }
      : isNode
        ? {
            lib: {
              entry: path.resolve("src/mcp/server.ts"),
              formats: ["es"],
              fileName: () => "mcp/server.js",
            },
            outDir: "dist",
            emptyOutDir: true,
            sourcemap: false,
            minify: false,
            target: "node24",
            rollupOptions: {
              external: (id: string) =>
                id === "@modelcontextprotocol/sdk" ||
                id === "zod" ||
                id.startsWith("node:") ||
                id.startsWith("@modelcontextprotocol/sdk/"),
              output: {
                entryFileNames: "mcp/server.js",
                inlineDynamicImports: true,
              },
            },
          }
        : undefined,
  };
});
