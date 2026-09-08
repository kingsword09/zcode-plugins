import type { Page } from "playwright-core";

export async function repaintCanvases(page: Page) {
  const frames = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frame.evaluate<{ repainted: number; skipped: number }>(`(() => {
        let repainted = 0;
        let skipped = 0;
        let remainingPixels = 16_000_000;
        for (const canvas of document.querySelectorAll("canvas")) {
          if (!canvas.getClientRects().length || !canvas.width || !canvas.height) continue;
          if (canvas.width * canvas.height > remainingPixels) { skipped++; continue; }
          try {
            const context = canvas.getContext("2d");
            const attributes = context?.getContextAttributes();
            if (!context || attributes?.colorSpace !== "srgb" || attributes?.colorType === "float16") { skipped++; continue; }
            // Electron offscreen can lose the presented layer after emulation.
            // putImageData refreshes it without applying transforms or blending.
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            context.putImageData(pixels, 0, 0);
            remainingPixels -= canvas.width * canvas.height;
            repainted++;
          } catch { skipped++; }
        }
        return { repainted, skipped };
      })()`);
    } catch { return { repainted: 0, skipped: 1 }; }
  }));
  return frames.reduce((total, frame) => ({ repainted: total.repainted + frame.repainted, skipped: total.skipped + frame.skipped }), { repainted: 0, skipped: 0 });
}
