import { join } from "node:path";
import { validOcrPage } from "./ocr.js";
import { atomicWrite, readJson } from "./storage.js";
import type { OcrPage } from "./pdf-types";

export function remapOcr(
  pages: Map<number, OcrPage>,
  mapping: (number | null)[],
  rotated: number[],
): Map<number, OcrPage> {
  const drop = new Set(rotated);
  const out = new Map<number, OcrPage>();
  for (const [index, page] of pages) {
    const target = mapping[index];
    if (target == null || drop.has(target)) continue;
    out.set(target, page);
  }
  return out;
}

export class OcrCache {
  constructor(private dataDir: string) {}

  private file(key: string) {
    return join(this.dataDir, "ocr", `${key}.json`);
  }

  async load(
    key: string,
    pageCount: number,
    legacyPdfPath?: string,
  ): Promise<Map<number, OcrPage>> {
    const out = new Map<number, OcrPage>();
    try {
      let entries: [string, any][] | null = null;
      const data = await readJson(this.file(key));
      if (data?.version === 3 && data.pages && typeof data.pages === "object")
        entries = Object.entries(data.pages);
      else if (legacyPdfPath && !legacyPdfPath.startsWith("unsaved://")) {
        const old = await readJson(`${legacyPdfPath}.ocr.json`);
        if (
          old?.version === 2 &&
          old.pdfFingerprint === key &&
          old.pages &&
          typeof old.pages === "object"
        )
          entries = Object.entries(old.pages);
      }
      for (const [k, page] of entries ?? []) {
        const index = Number(k);
        if (
          Number.isInteger(index) &&
          index >= 0 &&
          index < pageCount &&
          validOcrPage(page)
        )
          out.set(index, page);
      }
    } catch (error) {
      console.error("OCR cache load failed", error);
    }
    return out;
  }

  async save(key: string, pages: Map<number, OcrPage>): Promise<void> {
    try {
      const obj: Record<string, OcrPage> = {};
      for (const [i, p] of pages) obj[String(i)] = p;
      await atomicWrite(
        this.file(key),
        JSON.stringify({ version: 3, pages: obj }),
      );
    } catch (error) {
      console.error("OCR cache save failed", error);
    }
  }
}
