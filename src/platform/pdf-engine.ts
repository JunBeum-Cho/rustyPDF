import { searchLines } from "../search/model";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
type Invoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
type Line = { text: string; x: number; y: number; w: number; h: number };
export class RevisionCache<T> {
  private entries = new Map<
    string,
    { revision: number; promise: Promise<T> }
  >();
  get(id: string, revision: number, load: () => Promise<T>): Promise<T> {
    const old = this.entries.get(id);
    if (old?.revision === revision) return old.promise;
    if (old && old.revision > revision)
      return Promise.reject(new Error("stale document revision"));
    const entry = { revision, promise: null as unknown as Promise<T> };
    this.entries.set(id, entry);
    entry.promise = load()
      .then((value) => {
        if (this.entries.get(id) !== entry)
          throw new Error("stale document revision");
        return value;
      })
      .catch((error) => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
        throw error;
      });
    return entry.promise;
  }
  close(id: string) {
    this.entries.delete(id);
  }
  clear() {
    this.entries.clear();
  }
}
export function boundedViewport(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Invalid render dimensions");
  const ratio = Math.min(
    1,
    Math.sqrt(16_000_000 / (width * height)),
    16384 / width,
    16384 / height,
  );
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    ratio,
  };
}
export class PdfEngine {
  private cache = new RevisionCache<PDFDocumentProxy>();
  private documents = new Map<string, PDFDocumentProxy>();
  private generation = new Map<string, number>();
  private loadTokens = new Map<string, symbol>();
  constructor(private host: Invoke) {}
  close(id: string) {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    this.cache.close(id);
    this.loadTokens.delete(id);
    const old = this.documents.get(id);
    this.documents.delete(id);
    void old?.loadingTask.destroy();
  }
  dispose() {
    for (const id of new Set([
      ...this.documents.keys(),
      ...this.loadTokens.keys(),
    ]))
      this.close(id);
    this.cache.clear();
  }
  private async document(args: Record<string, unknown>) {
    const id = String(args.docId),
      revision = Number(args.expectedRevision);
    if (!Number.isInteger(revision) || revision < 0)
      throw new Error("Invalid revision");
    return this.cache.get(id, revision, async () => {
      const token = Symbol();
      this.loadTokens.set(id, token);
      const bytes = await this.host("pdf_document_bytes", {
        docId: id,
        expectedRevision: revision,
      });
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs/pdf.worker.min.mjs",
        document.baseURI,
      ).href;
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(bytes as Uint8Array),
        cMapUrl: new URL("pdfjs/cmaps/", document.baseURI).href,
        cMapPacked: true,
        standardFontDataUrl: new URL("pdfjs/standard_fonts/", document.baseURI)
          .href,
        wasmUrl: new URL("pdfjs/wasm/", document.baseURI).href,
      }).promise;
      if (this.loadTokens.get(id) !== token) {
        await doc.loadingTask.destroy();
        throw new Error("stale document revision");
      }
      const old = this.documents.get(id);
      if (old && old !== doc) void old.loadingTask.destroy();
      this.documents.set(id, doc);
      return doc;
    });
  }
  private async page(args: Record<string, unknown>) {
    const doc = await this.document(args);
    const index = Number(args.pageIndex);
    if (!Number.isInteger(index) || index < 0 || index >= doc.numPages)
      throw new Error("Invalid page index");
    return doc.getPage(index + 1);
  }
  private async canvas(page: PDFPageProxy, scale: number, rotation?: number) {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid scale");
    const angle = rotation ?? page.rotate;
    if (!Number.isFinite(angle) || angle % 90)
      throw new Error("Invalid rotation");
    let viewport = page.getViewport({
      scale: (scale * 96) / 72,
      rotation: angle,
    });
    const size = boundedViewport(viewport.width, viewport.height);
    viewport = page.getViewport({
      scale: ((scale * 96) / 72) * size.ratio,
      rotation: angle,
    });
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas unavailable");
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
      background: "white",
    }).promise;
    return { canvas, context, viewport };
  }
  private async lines(page: PDFPageProxy): Promise<Line[]> {
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const content = await page.getTextContent();
    const result: Line[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const [a, b, c, d, e, f] = item.transform;
      const [x, y] = viewport.convertToViewportPoint(e, f);
      const h = Math.max(1, Math.hypot(c, d));
      const w = Math.max(1, item.width);
      const p = viewport.convertToViewportPoint(
        e + (w * a) / Math.max(Math.hypot(a, b), 1),
        f + (w * b) / Math.max(Math.hypot(a, b), 1),
      );
      const q = viewport.convertToViewportPoint(e + c, f + d);
      const xs = [x, p[0], q[0], p[0] + q[0] - x],
        ys = [y, p[1], q[1], p[1] + q[1] - y];
      result.push({
        text: item.str,
        x: Math.min(...xs) / viewport.width,
        y: Math.min(...ys) / viewport.height,
        w: (Math.max(...xs) - Math.min(...xs) || w) / viewport.width,
        h: (Math.max(...ys) - Math.min(...ys) || h) / viewport.height,
      });
    }
    return result;
  }
  private async capture(page: PDFPageProxy, args: Record<string, unknown>) {
    const x = Number(args.x),
      y = Number(args.y),
      w = Number(args.w),
      h = Number(args.h),
      scale = Number(args.scale ?? 600 / 96);
    if (
      ![x, y, w, h, scale].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      w <= 0 ||
      h <= 0 ||
      x + w > 1.001 ||
      y + h > 1.001 ||
      scale <= 0
    )
      throw new Error("Invalid capture region");
    let viewport = page.getViewport({ scale: (scale * 96) / 72 });
    const size = boundedViewport(w * viewport.width, h * viewport.height);
    viewport = page.getViewport({ scale: ((scale * 96) / 72) * size.ratio });
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    try {
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, -x * viewport.width, -y * viewport.height],
        background: "white",
      }).promise;
      return await png(canvas);
    } finally {
      canvas.width = canvas.height = 0;
    }
  }
  async invoke(
    command: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const id = String(args.docId),
      generation = this.generation.get(id) ?? 0;
    let result: unknown;
    if (command === "pdf_search") {
      const query = String(args.query ?? "").toLocaleLowerCase();
      if (!query) return [];
      const doc = await this.document(args);
      const hits = [];
      for (let index = 0; index < doc.numPages; index++) {
        if ((this.generation.get(id) ?? 0) !== generation)
          throw new Error("stale document revision");
        const page = await doc.getPage(index + 1);
        const native = await this.lines(page);
        const ocr = (await this.host("pdf_ocr_lines", {
          ...args,
          pageIndex: index,
        })) as Line[] | null;
        hits.push(...searchLines(index, native, ocr ?? [], String(args.query)));
      }
      result = hits;
    } else {
      const page = await this.page(args);
      if (command === "pdf_text_lines") result = await this.lines(page);
      else if (command === "pdf_capture_region")
        result = await this.capture(page, args);
      else {
        const scale = Number(
          args.scale ?? (command === "pdf_ocr_page" ? 2 : 1),
        );
        const { canvas, context } = await this.canvas(
          page,
          scale,
          args.rotation === undefined
            ? undefined
            : (page.rotate + Number(args.rotation)) % 360,
        );
        try {
          if (command === "pdf_render_page") {
            const pixels = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            const output = new Uint8Array(8 + pixels.length);
            const view = new DataView(output.buffer);
            view.setUint32(0, canvas.width);
            view.setUint32(4, canvas.height);
            output.set(pixels, 8);
            result = output.buffer;
          } else if (command === "pdf_ocr_page") {
            const image = new Uint8Array(await png(canvas));
            result = await this.host(command, {
              ...args,
              image,
              imageWidth: canvas.width,
              imageHeight: canvas.height,
            });
          } else throw new Error("Unknown render command");
        } finally {
          canvas.width = canvas.height = 0;
        }
      }
    }
    if ((this.generation.get(id) ?? 0) !== generation)
      throw new Error("stale document revision");
    return result;
  }
}
function png(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? blob.arrayBuffer().then(resolve, reject)
          : reject(new Error("PNG encoding failed")),
      "image/png",
    ),
  );
}
