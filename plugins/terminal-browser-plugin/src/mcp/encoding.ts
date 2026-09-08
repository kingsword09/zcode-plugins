import { promises as fs } from "node:fs";
import path from "node:path";
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import encodeWebp, { init as initWebp } from "@jsquash/webp/encode.js";
import resize, { initResize } from "@jsquash/resize";
import { EncodedPacket, EncodedVideoPacketSource, Output, StreamTarget, WebMOutputFormat, type StreamTargetChunk } from "mediabunny";
import type { CodecPaths } from "./codec-assets.ts";
import { BrowserError } from "./errors.ts";

export interface RecordingFrame { file: string; at: number }
const maximumOutputBytes = 256 * 1024 * 1024;
let initialized: Promise<void> | undefined;

async function initializeCodecs(assets: CodecPaths) {
  initialized ??= (async () => {
    const [jpeg, webp, simd, resizer] = await Promise.all([assets.jpeg, assets.webp, assets.webpSimd, assets.resize].map((file) => fs.readFile(file)));
    await Promise.all([
      WebAssembly.compile(jpeg!).then((module) => initJpeg(module)),
      WebAssembly.compile(WebAssembly.validate(simd!) ? simd! : webp!).then((module) => initWebp(module)),
      initResize(resizer!),
    ]);
  })();
  await initialized;
}

export function recordingTimeline(frames: RecordingFrame[], durationMs: number) {
  if (!frames.length || frames[0]!.at !== 0 || !Number.isFinite(durationMs) || durationMs <= 0) throw new BrowserError("invalid_recording", "Recording requires frames starting at zero and a positive duration.");
  return frames.map((frame, index) => {
    const end = frames[index + 1]?.at ?? durationMs;
    if (!/^frame-\d+\.jpg$/.test(frame.file) || !Number.isFinite(frame.at) || frame.at < 0 || end < frame.at || end > durationMs) throw new BrowserError("invalid_recording", "Recording frame paths and timestamps are invalid.");
    return { ...frame, durationMs: Math.max(1, end - frame.at) };
  });
}

export function vp8Payload(webp: Uint8Array): Uint8Array {
  const buffer = Buffer.from(webp.buffer, webp.byteOffset, webp.byteLength);
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP" || buffer.readUInt32LE(4) + 8 !== buffer.length) throw new BrowserError("encoding_failed", "Encoder returned an invalid WebP container.");
  // WebP stores the VP8 keyframe in a RIFF chunk; WebM takes the raw payload.
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > buffer.length) break;
    if (buffer.toString("ascii", offset, offset + 4) === "VP8 " && size > 0) return buffer.subarray(offset + 8, end);
    offset = end + (size & 1);
  }
  throw new BrowserError("encoding_failed", "Encoder did not return a lossy VP8 frame.");
}

interface EncodeRecordingOptions {
  directory: string;
  outputPath: string;
  frames: RecordingFrame[];
  durationMs: number;
  width: number;
  height: number;
  quality: number;
  assets: CodecPaths;
  check: () => Promise<void>;
  onProgress: (progress: number) => Promise<void>;
}

export async function encodeRecording(options: EncodeRecordingOptions): Promise<void> {
  const { width, height, durationMs } = options;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 || width * height > 16_777_216) throw new BrowserError("recording_limit", "Recording dimensions exceed the 16 megapixel encoding limit.");
  const timeline = recordingTimeline(options.frames, durationMs);
  await options.check();
  await initializeCodecs(options.assets);
  const file = await fs.open(options.outputPath, "wx", 0o600);
  const output = new Output({ format: new WebMOutputFormat(), target: new StreamTarget(new WritableStream<StreamTargetChunk>({
    async write({ data, position }) {
      if (position + data.byteLength > maximumOutputBytes) throw new BrowserError("recording_limit", "Encoded recording exceeded the 256 MB limit.");
      let offset = 0;
      while (offset < data.byteLength) {
        const { bytesWritten } = await file.write(data, offset, data.byteLength - offset, position + offset);
        if (!bytesWritten) throw new BrowserError("encoding_failed", "Could not write the recording.");
        offset += bytesWritten;
      }
    },
  }), { chunked: true, chunkSize: 64 * 1024 }) });
  const source = new EncodedVideoPacketSource("vp8");
  output.addVideoTrack(source);
  let complete = false;
  try {
    await output.start();
    let last: Uint8Array | undefined;
    for (const [index, frame] of timeline.entries()) {
      await options.check();
      const jpeg = new Uint8Array(await fs.readFile(path.join(options.directory, frame.file)));
      const image = await decodeJpeg(jpeg.buffer);
      const scale = Math.min(width / image.width, height / image.height);
      const fittedWidth = Math.max(1, Math.round(image.width * scale));
      const fittedHeight = Math.max(1, Math.round(image.height * scale));
      let normalized = image.width === fittedWidth && image.height === fittedHeight ? image : await resize(image, { width: fittedWidth, height: fittedHeight, method: "triangle" });
      if (fittedWidth !== width || fittedHeight !== height) {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
        const left = Math.floor((width - fittedWidth) / 2);
        const top = Math.floor((height - fittedHeight) / 2);
        for (let row = 0; row < fittedHeight; row++) data.set(normalized.data.subarray(row * fittedWidth * 4, (row + 1) * fittedWidth * 4), ((top + row) * width + left) * 4);
        normalized = { data, width, height, colorSpace: "srgb" };
      }
      last = vp8Payload(new Uint8Array(await encodeWebp(normalized, { quality: options.quality, method: 0, lossless: 0, thread_level: 0 })));
      await options.check();
      await source.add(new EncodedPacket(last, "key", frame.at / 1000, frame.durationMs / 1000), { decoderConfig: { codec: "vp8", codedWidth: width, codedHeight: height } });
      await options.onProgress((index + 1) / timeline.length);
    }
    // Anchor the last image near the end for readers that infer duration from timestamps.
    if (durationMs - 1 > timeline.at(-1)!.at) await source.add(new EncodedPacket(last!, "key", (durationMs - 1) / 1000, 0.001));
    await options.check();
    await output.finalize();
    complete = true;
  } finally {
    if (!complete) await output.cancel().catch(() => {});
    await file.close();
    if (!complete) await fs.unlink(options.outputPath).catch(() => {});
  }
}
