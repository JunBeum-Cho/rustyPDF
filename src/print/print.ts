import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Tab } from "../state/document";

export const PRINT_DPI = 150;
export const MAX_PRINT_PAGES = 2000;

export interface PrintPage {
  png: Uint8Array;
  widthPt: number;
  heightPt: number;
}

export interface PrintDeps {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  toast: (message: string, kind?: "info" | "error") => void;
  buildPayload: (tab: Tab) => Promise<unknown>;
  openBytes: (bytes: Uint8Array) => Promise<PDFDocumentProxy>;
  getDocument: (docId: string, revision: number) => Promise<PDFDocumentProxy>;
  renderPage: (doc: PDFDocumentProxy, index: number, dpi: number) => Promise<PrintPage>;
  fileName: (path: string) => string;
}

/** Render one page to a white-background PNG at the given dpi. */
export async function renderPagePng(
  doc: PDFDocumentProxy,
  index: number,
  dpi: number,
): Promise<PrintPage> {
  const page = await doc.getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    try {
      await page.render({
        canvas,
        viewport,
        background: "#ffffff",
        annotationMode: 1, // AnnotationMode.ENABLE
      } as never).promise;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("PNG 인코딩 실패"))),
          "image/png",
        ),
      );
      const png = new Uint8Array(await blob.arrayBuffer());
      return { png, widthPt: base.width, heightPt: base.height };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    page.cleanup();
  }
}

export async function runPrint(tab: Tab, deps: PrintDeps): Promise<void> {
  let temp: PDFDocumentProxy | null = null;
  try {
    let doc: PDFDocumentProxy;
    if (tab.readOnly) {
      doc = await deps.getDocument(tab.docId, tab.revision);
    } else {
      const bytes = await deps.invoke<Uint8Array>("pdf_flatten_bytes", {
        docId: tab.docId,
        expectedRevision: tab.revision,
        data: await deps.buildPayload(tab),
        includeOcr: false,
      });
      temp = doc = await deps.openBytes(bytes);
    }
    const total = doc.numPages;
    if (total > MAX_PRINT_PAGES) {
      deps.toast(`인쇄 실패: ${MAX_PRINT_PAGES}쪽을 초과하는 문서는 인쇄할 수 없습니다`, "error");
      return;
    }
    const pages: PrintPage[] = [];
    for (let i = 0; i < total; i++) {
      if (i % 5 === 0) deps.toast(`인쇄 준비 중 ${i + 1}/${total}`);
      pages.push(await deps.renderPage(doc, i, PRINT_DPI));
    }
    const ok = await deps.invoke<boolean>("print_images", {
      pages,
      title: deps.fileName(tab.path),
    });
    if (!ok) deps.toast("인쇄를 취소했습니다", "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    deps.toast(`인쇄 실패: ${msg}`, "error");
  } finally {
    if (temp) await temp.loadingTask.destroy().catch(() => undefined);
  }
}

export async function printActiveDocument(): Promise<void> {
  const [{ activeTab, fileNameFromPath }, { enqueueDocumentMutation }, desktop, engine, capture, ipc] =
    await Promise.all([
      import("../state/document"),
      import("../ipc/documentMutations"),
      import("../platform/desktop"),
      import("../platform/pdf-engine"),
      import("../capture/capture"),
      import("../ipc/pdf"),
    ]);
  const tab = activeTab();
  if (!tab) return;
  const build = (ipc as unknown as { buildAnnotationPayload: PrintDeps["buildPayload"] })
    .buildAnnotationPayload;
  await enqueueDocumentMutation(tab.tabId, () =>
    runPrint(tab, {
      invoke: desktop.invoke,
      toast: (m, k) => capture.emitToast(m, k),
      buildPayload: build,
      openBytes: (b) => engine.pdfEngine().openBytes(b),
      getDocument: (d, r) => engine.pdfEngine().getDocument(d, r),
      renderPage: renderPagePng,
      fileName: fileNameFromPath,
    }),
  );
}
