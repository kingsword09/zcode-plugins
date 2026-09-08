import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import encodeJpeg, { init as initJpegEncoder } from "@jsquash/jpeg/encode.js";
import { BufferSource, EncodedPacketSink, Input, WEBM } from "mediabunny";
import { codecPaths } from "../src/mcp/codec-assets.ts";
import { encodeRecording, recordingTimeline, vp8Payload } from "../src/mcp/encoding.ts";

let root: string;
let frame: Uint8Array<ArrayBuffer>;
const assets = codecPaths(import.meta.url);
const frames = [{ file: "frame-00000.jpg", at: 0 }, { file: "frame-00001.jpg", at: 700 }];
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tb-encoder-"));
  const require = createRequire(import.meta.url);
  await initJpegEncoder(await WebAssembly.compile(await readFile(require.resolve("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"))));
  const data = new Uint8ClampedArray(16 * 8 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([220, 40, 60, 255], offset);
  frame = new Uint8Array(await encodeJpeg({ data, width: 16, height: 8, colorSpace: "srgb" }));
  for (const item of frames) await writeFile(path.join(root, item.file), frame);
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("bundled codecs create a private, seekable WebM with the complete timeline", async () => {
  const outputPath = path.join(root, "result.webm");
  const progress: number[] = [];
  await encodeRecording({ directory: root, outputPath, frames, durationMs: 1500, width: 32, height: 24, quality: 80, assets, check: async () => {}, onProgress: async (value) => { progress.push(value); } });
  const media = new Input({ source: new BufferSource(await readFile(outputPath)), formats: [WEBM] });
  try {
    const track = (await media.getPrimaryVideoTrack())!;
    expect([track.codedWidth, track.codedHeight]).toEqual([32, 24]);
    expect(await media.getDurationFromMetadata()).toBeCloseTo(1.5, 2);
    expect(await media.computeDuration()).toBeGreaterThan(1.49);
    const packets = [];
    for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
    expect(packets.map((packet) => packet.timestamp)).toEqual([0, 0.7, 1.499]);
    expect(packets.every((packet) => packet.type === "key" && packet.data.byteLength > 0)).toBe(true);
    expect(progress).toEqual([0.5, 1]);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  } finally { media.dispose(); }
});

test("cancellation during encoding removes partial video and retains captured frames", async () => {
  const outputPath = path.join(root, "cancelled.webm");
  let cancel = false;
  await expect(encodeRecording({ directory: root, outputPath, frames, durationMs: 1500, width: 32, height: 24, quality: 80, assets,
    check: async () => { if (cancel) throw new Error("encoding cancelled"); },
    onProgress: async () => { cancel = true; },
  })).rejects.toThrow("encoding cancelled");
  expect(existsSync(outputPath)).toBe(false);
  expect(new Uint8Array(await readFile(path.join(root, frames[0]!.file)))).toEqual(frame);
});

test("malformed containers and unsafe frame timelines are rejected", () => {
  expect(() => vp8Payload(new Uint8Array(32))).toThrow("invalid WebP");
  const truncated = Buffer.from("RIFF\x20\0\0\0WEBPVP8 \x08\0\0\0", "binary");
  expect(() => vp8Payload(truncated)).toThrow("invalid WebP");
  expect(() => recordingTimeline([{ file: "../frame-00000.jpg", at: 0 }], 1000)).toThrow("paths and timestamps");
  expect(() => recordingTimeline([{ file: "frame-00000.jpg", at: 10 }], 1000)).toThrow("starting at zero");
  expect(() => recordingTimeline(frames, 500)).toThrow("paths and timestamps");
});
