import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
import type { OcrPage } from "./pdf-types.js";
const require = createRequire(import.meta.url);
export function normalizeOcr(
  data: any,
  width: number,
  height: number,
): OcrPage {
  if (!data || typeof data.text !== "string")
    throw new Error("Malformed OCR result");
  const lines: any[] = [];
  for (const block of data.blocks ?? [])
    for (const paragraph of block.paragraphs ?? [])
      for (const line of paragraph.lines ?? []) lines.push(line);
  if (!data.blocks && Array.isArray(data.lines)) lines.push(...data.lines);
  return {
    text: data.text,
    lines: lines.map((line) => {
      const b = line.bbox;
      if (
        typeof line.text !== "string" ||
        !b ||
        ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)
      )
        throw new Error("Malformed OCR line");
      const x = Math.max(0, Math.min(1, b.x0 / width)),
        y = Math.max(0, Math.min(1, b.y0 / height));
      return {
        text: line.text,
        x,
        y,
        w: Math.max(0, Math.min(1 - x, (b.x1 - b.x0) / width)),
        h: Math.max(0, Math.min(1 - y, (b.y1 - b.y0) / height)),
      };
    }),
  };
}
export function validOcrPage(page: any): page is OcrPage {
  return (
    page &&
    typeof page.text === "string" &&
    Array.isArray(page.lines) &&
    page.lines.every(
      (l: any) =>
        typeof l.text === "string" &&
        ["x", "y", "w", "h"].every(
          (k) => Number.isFinite(l[k]) && l[k] >= 0 && l[k] <= 1,
        ),
    )
  );
}
export class OcrEngine {
  private worker: Promise<any> | null = null;
  constructor(
    private dataDir: string,
    private assetsDir?: string,
  ) {}
  private async getWorker() {
    if (!this.worker)
      this.worker = (async () => {
        const { createWorker, OEM } = await import("tesseract.js");
        const cachePath = join(this.dataDir, "ocr-models");
        await mkdir(cachePath, { recursive: true });
        let langPath = this.assetsDir
          ? join(this.assetsDir, "tessdata")
          : join(this.dataDir, "bundled-tessdata");
        if (!this.assetsDir) {
          await mkdir(langPath, { recursive: true });
          for (const lang of ["eng", "kor"]) {
            const entry = require(`@tesseract.js-data/${lang}`);
            await copyFile(
              join(entry.langPath, `${lang}.traineddata.gz`),
              join(langPath, `${lang}.traineddata.gz`),
            );
          }
        }
        return createWorker(["eng", "kor"], OEM.LSTM_ONLY, {
          langPath,
          cachePath,
          gzip: true,
          // Tesseract already rejects the recognition promise; suppress its default uncaught throw.
          errorHandler: () => {},
          workerPath: this.assetsDir
            ? join(this.assetsDir, "tesseract/worker-script/node/index.js")
            : require.resolve("tesseract.js/src/worker-script/node/index.js"),
        });
      })();
    return this.worker;
  }
  async recognize(image: Uint8Array, width: number, height: number) {
    const worker = await this.getWorker();
    const result = await worker.recognize(
      Buffer.from(image),
      {},
      { text: true, blocks: true },
    );
    return normalizeOcr(result.data, width, height);
  }
  async dispose() {
    if (this.worker) await (await this.worker).terminate();
    this.worker = null;
  }
}
