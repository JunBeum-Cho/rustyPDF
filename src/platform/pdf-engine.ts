import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

export type PasswordProvider = (
  docId: string,
  retry: boolean,
) => Promise<string | null>;
export interface OcrPagePayload {
  text: string;
  lines: { text: string; x: number; y: number; w: number; h: number }[];
}
export interface RenderRequest {
  docId: string;
  revision: number;
  pageIndex: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}
export interface CaptureRegion {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  scale?: number;
}
type Invoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
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
  private loadTokens = new Map<string, symbol>();
  private passwords: PasswordProvider = async () => null;
  constructor(private host: Invoke) {}
  setPasswordProvider(provider: PasswordProvider) {
    this.passwords = provider;
  }
  close(id: string) {
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
  private async load(
    bytes: Uint8Array,
    onPassword?: (retry: boolean) => Promise<string | null>,
  ): Promise<PDFDocumentProxy> {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs/pdf.worker.min.mjs",
      document.baseURI,
    ).href;
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      cMapUrl: new URL("pdfjs/cmaps/", document.baseURI).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("pdfjs/standard_fonts/", document.baseURI)
        .href,
      wasmUrl: new URL("pdfjs/wasm/", document.baseURI).href,
    });
    return await new Promise<PDFDocumentProxy>((resolve, reject) => {
      task.onPassword = (
        update: (password: string) => void,
        reason: number,
      ) => {
        const provider = onPassword ?? (async () => null);
        provider(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then(
          (password) => {
            if (password === null) {
              void task.destroy();
              reject(new Error("암호가 필요합니다"));
            } else update(password);
          },
          (error) => {
            void task.destroy();
            reject(error);
          },
        );
      };
      task.promise.then(resolve, reject);
    });
  }
  async openBytes(bytes: Uint8Array): Promise<PDFDocumentProxy> {
    return this.load(bytes);
  }
  getDocument(docId: string, revision: number): Promise<PDFDocumentProxy> {
    if (!Number.isInteger(revision) || revision < 0)
      return Promise.reject(new Error("Invalid revision"));
    return this.cache.get(docId, revision, async () => {
      const token = Symbol();
      this.loadTokens.set(docId, token);
      const bytes = await this.host("pdf_document_bytes", {
        docId,
        expectedRevision: revision,
      });
      const doc = await this.load(new Uint8Array(bytes as Uint8Array), (retry) =>
        this.passwords(docId, retry),
      );
      if (this.loadTokens.get(docId) !== token) {
        await doc.loadingTask.destroy();
        throw new Error("stale document revision");
      }
      const old = this.documents.get(docId);
      if (old && old !== doc) void old.loadingTask.destroy();
      this.documents.set(docId, doc);
      return doc;
    });
  }
  private async page(docId: string, revision: number, index: number) {
    const doc = await this.getDocument(docId, revision);
    if (!Number.isInteger(index) || index < 0 || index >= doc.numPages)
      throw new Error("Invalid page index");
    return doc.getPage(index + 1);
  }
  renderPage(
    canvas: HTMLCanvasElement,
    req: RenderRequest,
  ): { promise: Promise<void>; cancel(): void } {
    let cancelled = false;
    let task: { promise: Promise<unknown>; cancel(): void } | undefined;
    let scratch: HTMLCanvasElement | undefined;
    const promise = (async () => {
      const page = await this.page(req.docId, req.revision, req.pageIndex);
      if (cancelled) return;
      const dpr = Number.isFinite(req.dpr) && req.dpr > 0 ? req.dpr : 1;
      const size = boundedViewport(req.cssWidth * dpr, req.cssHeight * dpr);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: size.width / base.width });
      // Draw straight into the visible canvas unless that would blank an
      // existing bitmap (a resize clears it); then draw aside and swap.
      const aside =
        canvas.width > 0 &&
        (canvas.width !== size.width || canvas.height !== size.height);
      const target = aside ? document.createElement("canvas") : canvas;
      if (aside) scratch = target;
      target.width = size.width;
      target.height = size.height;
      const context = target.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      const { AnnotationMode } = await import("pdfjs-dist");
      if (cancelled) return;
      task = page.render({
        canvas: target,
        canvasContext: context,
        viewport,
        background: "white",
        annotationMode: AnnotationMode.ENABLE_FORMS,
      });
      try {
        await task.promise;
      } catch (error) {
        if (cancelled) return;
        throw error;
      }
      if (cancelled) return;
      if (aside) {
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.getContext("2d")?.drawImage(target, 0, 0);
      }
    })().finally(() => {
      if (scratch) scratch.width = scratch.height = 0;
    });
    return {
      promise,
      cancel() {
        cancelled = true;
        try {
          task?.cancel();
        } catch {
          /* already finished */
        }
      },
    };
  }
  private async rasterize(
    page: PDFPageProxy,
    scale: number,
    region?: { x: number; y: number; w: number; h: number },
  ) {
    let viewport = page.getViewport({ scale: (scale * 96) / 72 });
    const size = boundedViewport(
      (region?.w ?? 1) * viewport.width,
      (region?.h ?? 1) * viewport.height,
    );
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
        ...(region
          ? {
              transform: [
                1,
                0,
                0,
                1,
                -region.x * viewport.width,
                -region.y * viewport.height,
              ],
            }
          : {}),
        background: "white",
      }).promise;
      return { image: await png(canvas), width: size.width, height: size.height };
    } finally {
      canvas.width = canvas.height = 0;
    }
  }
  async capture(
    docId: string,
    revision: number,
    region: CaptureRegion,
  ): Promise<ArrayBuffer> {
    const { x, y, w, h } = region;
    const scale = Number(region.scale ?? 600 / 96);
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
    const page = await this.page(docId, revision, region.pageIndex);
    return (await this.rasterize(page, scale, { x, y, w, h })).image;
  }
  async recognizePage(
    docId: string,
    revision: number,
    pageIndex: number,
  ): Promise<OcrPagePayload> {
    const page = await this.page(docId, revision, pageIndex);
    const { image, width, height } = await this.rasterize(page, 2);
    return (await this.host("pdf_ocr_page", {
      docId,
      expectedRevision: revision,
      pageIndex,
      image: new Uint8Array(image),
      imageWidth: width,
      imageHeight: height,
    })) as OcrPagePayload;
  }
  async pageHasText(
    docId: string,
    revision: number,
    pageIndex: number,
  ): Promise<boolean> {
    const page = await this.page(docId, revision, pageIndex);
    const content = await page.getTextContent();
    return content.items.some(
      (item) => "str" in item && item.str.trim().length > 0,
    );
  }
}
let singleton: PdfEngine | undefined;
let hostOverride: Invoke | undefined;
/** Drops the shared engine; the next pdfEngine() call builds a fresh one. */
export function resetPdfEngine(host?: Invoke) {
  singleton?.dispose();
  singleton = undefined;
  hostOverride = host;
}
export function pdfEngine(): PdfEngine {
  return (singleton ??= new PdfEngine(
    hostOverride ??
      ((command, args) => {
        const desktop = globalThis.window?.desktop;
        if (!desktop) throw new Error("Electron desktop bridge unavailable");
        return desktop.invoke(command, args);
      }),
  ));
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
