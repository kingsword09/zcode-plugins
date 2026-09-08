import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const codecAssets = {
  jpeg: { file: "mozjpeg-dec.wasm", module: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm" },
  webp: { file: "webp-enc.wasm", module: "@jsquash/webp/codec/enc/webp_enc.wasm" },
  webpSimd: { file: "webp-enc-simd.wasm", module: "@jsquash/webp/codec/enc/webp_enc_simd.wasm" },
  resize: { file: "resize.wasm", module: "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm" },
} as const;

export type CodecPaths = Record<keyof typeof codecAssets, string>;

export function codecPaths(entryUrl: string): CodecPaths {
  const require = entryUrl.endsWith(".ts") ? createRequire(entryUrl) : undefined;
  return Object.fromEntries(Object.entries(codecAssets).map(([name, asset]) => [name,
    require ? require.resolve(asset.module) : fileURLToPath(new URL(`../assets/recording/${asset.file}`, entryUrl)),
  ])) as CodecPaths;
}
