import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, extname } from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import { AnnotationStore } from "./annotation-store.js";
import { atomicWrite, fingerprint, readJson, sameFile } from "./storage.js";
import { OcrEngine, validOcrPage } from "./ocr.js";
import { flattenPdf } from "./export.js";
import type { DocumentState } from "./pdf-types.js";
function pathArg(value: unknown) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))
    throw new Error("Expected absolute file path");
  return value;
}
function meta(pdf: PDFDocument) {
  return pdf.getPages().map((page, index) => {
    const box = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation))
      throw new Error("Invalid page rotation");
    return {
      index,
      width: rotation % 180 ? box.height : box.width,
      height: rotation % 180 ? box.width : box.height,
      rotation,
    };
  });
}
export class PdfService {
  private documents = new Map<string, DocumentState>();
  private store: AnnotationStore;
  private ocr: OcrEngine;
  private clipboard: { id: string; bytes: Uint8Array } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(
    private options: {
      dataDir: string;
      legacyDataDirs?: string[];
      assetsDir?: string;
    },
  ) {
    this.store = new AnnotationStore(
      join(options.dataDir, "annotations"),
      (options.legacyDataDirs ?? []).map((d) => join(d, "annotations")),
    );
    this.ocr = new OcrEngine(options.dataDir, options.assetsDir);
  }
  invoke(command: string, args: Record<string, unknown> = {}): Promise<any> {
    const operation = this.tail.then(() => {
      if (this.disposed) throw new Error("Service disposed");
      return this.dispatch(command, args);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  private get(a: Record<string, unknown>, revision = true) {
    const d = this.documents.get(String(a.docId));
    if (!d) throw new Error("Document closed or unknown");
    if (
      revision &&
      (!Number.isSafeInteger(a.expectedRevision) ||
        a.expectedRevision !== d.revision)
    )
      throw new Error(
        `Stale document revision: expected ${a.expectedRevision}, actual ${d.revision}`,
      );
    return d;
  }
  private payload(d: DocumentState) {
    return {
      id: d.id,
      revision: d.revision,
      path: d.path,
      pageCount: d.pages.length,
      pages: d.pages,
      fileSize: d.bytes.length,
    };
  }
  private async unchanged(d: DocumentState, path = d.path) {
    if (await sameFile(d.path, path)) {
      let disk;
      try {
        disk = await readFile(path);
      } catch {
        throw new Error("External PDF modification: source is missing");
      }
      if (fingerprint(disk) !== d.diskFingerprint)
        throw new Error("External PDF modification detected");
    }
  }
  private async conflict(path: string, except?: string) {
    for (const d of this.documents.values())
      if (d.id !== except && (await sameFile(d.path, path)))
        throw new Error("Target PDF is open in another document");
  }
  private indices(a: Record<string, unknown>, count: number) {
    if (
      !Array.isArray(a.indices) ||
      !a.indices.length ||
      a.indices.some((i) => !Number.isInteger(i) || i < 0 || i >= count)
    )
      throw new Error("Invalid page indices");
    return [...new Set(a.indices as number[])].sort((x, y) => x - y);
  }
  private async flush(d: DocumentState) {
    if (!d.ocrDirty || d.path.startsWith("unsaved://")) return;
    await this.unchanged(d);
    await atomicWrite(
      `${d.path}.ocr.json`,
      JSON.stringify({
        version: 2,
        pdfFingerprint: fingerprint(d.bytes),
        documentRevision: d.revision,
        pages: Object.fromEntries(d.ocr),
      }),
    );
    d.ocrDirty = false;
  }
  private async register(
    path: string,
    bytes: Uint8Array,
    diskFingerprint: string,
  ) {
    const pdf = await PDFDocument.load(bytes);
    if (!pdf.getPageCount()) throw new Error("PDF has no pages");
    const d: DocumentState = {
      id: randomUUID(),
      path,
      revision: 0,
      bytes: bytes.slice(),
      diskFingerprint,
      pages: meta(pdf),
      ocr: new Map(),
      ocrDirty: false,
      history: new Map(),
    };
    const cached = path.startsWith("unsaved://")
      ? null
      : await readJson(`${path}.ocr.json`);
    if (
      cached?.version === 2 &&
      cached.pdfFingerprint === fingerprint(bytes) &&
      cached.pages
    )
      for (const [key, page] of Object.entries(cached.pages))
        if (
          /^\d+$/.test(key) &&
          Number(key) < d.pages.length &&
          validOcrPage(page)
        )
          d.ocr.set(Number(key), page);
    this.documents.set(d.id, d);
    return this.payload(d);
  }
  private async dispatch(
    command: string,
    a: Record<string, unknown>,
  ): Promise<any> {
    if (command === "pdf_open") {
      const path = pathArg(a.path);
      for (const d of this.documents.values())
        if (await sameFile(d.path, path)) return this.payload(d);
      const bytes = await readFile(path);
      return this.register(path, bytes, fingerprint(bytes));
    }
    if (command === "pdf_create_from_images") return this.images(a);
    if (command === "pdf_close") {
      const d = this.get(a, false);
      await this.flush(d);
      this.documents.delete(d.id);
      return;
    }
    const d = this.get(a);
    if (d.pendingRestore && ["pdf_delete_pages", "pdf_duplicate_pages", "pdf_paste_pages", "pdf_rotate_pages", "pdf_save_document", "annotations_save", "export_annotated_pdf"].includes(command))
      throw new Error("Restore transaction pending");
    switch (command) {
      case "pdf_accept_restore":
      case "pdf_rollback_restore": {
        const pending = d.pendingRestore;
        if (!pending || pending.id !== a.restoreTransaction) throw new Error("Restore transaction expired");
        if (command === "pdf_rollback_restore") {
          d.bytes = pending.previous.bytes;
          d.pages = pending.previous.pages;
          d.history.set(pending.token, pending.target);
          d.revision++;
          d.ocr.clear();
          d.ocrDirty = false;
          this.trimHistory(d);
        }
        d.pendingRestore = undefined;
        return { ...this.payload(d), retainedHistoryTokens: [...d.history.keys()] };
      }
      case "pdf_restore_snapshot": {
        if (d.pendingRestore) throw new Error("Restore transaction pending");
        const token = String(a.token);
        const snapshot = d.history.get(token);
        if (!snapshot) throw new Error("Document history expired");
        // One transient rollback reference to the formerly active PDF is
        // separate from the 64 MiB retained-history budget. No bytes are
        // copied, and acknowledgement/rollback/close releases the reference.
        if (a.transactional === true) d.pendingRestore = {
          id: randomUUID(), token, previous: {bytes: d.bytes, pages: d.pages}, target: snapshot,
        };
        d.history.set(token, { bytes: d.bytes, pages: d.pages });
        d.bytes = snapshot.bytes;
        d.pages = snapshot.pages;
        d.revision++;
        d.ocr.clear();
        d.ocrDirty = false;
        this.trimHistory(d);
        return { ...this.payload(d), retainedHistoryTokens: [...d.history.keys()], restoreTransaction: d.pendingRestore?.id };
      }
      case "pdf_document_bytes":
        return d.bytes.slice();
      case "annotations_load":
        if (a.path !== d.path) throw new Error("Annotation path mismatch");
        return this.store.load(d.path, d.bytes);
      case "annotations_save":
        if (a.path !== d.path) throw new Error("Annotation path mismatch");
        await this.unchanged(d);
        await this.store.save(d.path, d.bytes, a.data);
        return;
      case "pdf_ocr_status":
        return [...d.ocr.keys()].sort((x, y) => x - y);
      case "pdf_ocr_lines":
        this.pageIndex(a, d);
        return d.ocr.get(a.pageIndex as number)?.lines ?? null;
      case "pdf_ocr_flush":
        await this.flush(d);
        return;
      case "pdf_ocr_page": {
        const index = this.pageIndex(a, d);
        if (d.ocr.has(index)) return d.ocr.get(index);
        if (
          !(a.image instanceof Uint8Array) ||
          a.image.length < 8 ||
          a.image.length > 200 * 1024 * 1024 ||
          !Number.isInteger(a.imageWidth) ||
          !Number.isInteger(a.imageHeight) ||
          Number(a.imageWidth) <= 0 ||
          Number(a.imageHeight) <= 0 ||
          Number(a.imageWidth) * Number(a.imageHeight) > 32_000_000
        )
          throw new Error("Invalid OCR image");
        const page = await this.ocr.recognize(
          a.image,
          Number(a.imageWidth),
          Number(a.imageHeight),
        );
        this.get(a);
        d.ocr.set(index, page);
        d.ocrDirty = true;
        return page;
      }
      case "pdf_copy_pages": {
        const pdf = await PDFDocument.load(d.bytes);
        const copy = await PDFDocument.create();
        for (const p of await copy.copyPages(
          pdf,
          this.indices(a, d.pages.length),
        ))
          copy.addPage(p);
        const bytes = await copy.save();
        if (bytes.length > 200 * 1024 * 1024)
          throw new Error("Page clipboard exceeds 200MB");
        this.clipboard = { id: randomUUID(), bytes };
        return this.clipboard.id;
      }
      case "pdf_delete_pages":
      case "pdf_duplicate_pages":
      case "pdf_paste_pages":
      case "pdf_rotate_pages":
        return this.edit(command, a, d);
      case "pdf_save_document": {
        const target = pathArg(a.targetPath);
        await this.conflict(target, d.id);
        await this.unchanged(d, target);
        await this.flush(d);
        const bytes = a.data
          ? await flattenPdf(d.bytes, a.data, this.options.assetsDir)
          : d.bytes;
        let sidecar = a.sidecar;
        if (sidecar) sidecar = await this.store.stage(target, bytes, sidecar);
        await this.unchanged(d, target);
        await atomicWrite(target, bytes);
        d.bytes = bytes;
        d.path = target;
        d.diskFingerprint = fingerprint(bytes);
        d.revision++;
        if (sidecar) await this.store.save(target, bytes, sidecar);
        if (d.ocr.size) {
          d.ocrDirty = true;
          await this.flush(d);
        }
        return this.payload(d);
      }
      case "export_annotated_pdf": {
        const target = pathArg(a.targetPath);
        // Completed recognition belongs to this export invocation. Copy each
        // line before the first await so later cache changes cannot leak in.
        const ocrPages = new Map([...d.ocr].map(([index, page]) => [index, {
          text: page.text,
          lines: page.lines.map(line => ({ ...line })),
        }]));
        await this.conflict(target);
        await atomicWrite(
          target,
          await flattenPdf(d.bytes, a.data, this.options.assetsDir, ocrPages),
        );
        return;
      }
      default:
        throw new Error(`Unsupported PDF command: ${command}`);
    }
  }
  private pageIndex(a: Record<string, unknown>, d: DocumentState) {
    if (
      !Number.isInteger(a.pageIndex) ||
      Number(a.pageIndex) < 0 ||
      Number(a.pageIndex) >= d.pages.length
    )
      throw new Error("Invalid page index");
    return Number(a.pageIndex);
  }
  private async edit(
    command: string,
    a: Record<string, unknown>,
    d: DocumentState,
  ) {
    const pdf = await PDFDocument.load(d.bytes);
    let mapping: Array<number | null> = d.pages.map((_, i) => i);
    if (command === "pdf_paste_pages") {
      if (!this.clipboard || a.clipboardId !== this.clipboard.id)
        throw new Error("Clipboard expired");
      if (
        !Number.isInteger(a.afterIndex) ||
        Number(a.afterIndex) < -1 ||
        Number(a.afterIndex) >= d.pages.length
      )
        throw new Error("Invalid insertion index");
      const at = Number(a.afterIndex) + 1;
      const source = await PDFDocument.load(this.clipboard.bytes);
      const pages = await pdf.copyPages(source, source.getPageIndices());
      pages.forEach((p, i) => pdf.insertPage(at + i, p));
      mapping = mapping.map((i) => (i! >= at ? i! + pages.length : i));
    } else {
      const indices = this.indices(a, d.pages.length);
      if (command === "pdf_delete_pages") {
        if (indices.length === pdf.getPageCount())
          throw new Error("Cannot delete every page");
        for (const i of [...indices].reverse()) pdf.removePage(i);
        mapping = mapping.map((i) =>
          indices.includes(i!)
            ? null
            : i! - indices.filter((n) => n < i!).length,
        );
      } else if (command === "pdf_rotate_pages") {
        if (a.direction !== 1 && a.direction !== -1)
          throw new Error("Invalid rotation direction");
        for (const i of indices) {
          const p = pdf.getPage(i);
          p.setRotation(
            degrees(
              (p.getRotation().angle + Number(a.direction) * 90 + 360) % 360,
            ),
          );
        }
      } else {
        const at = indices[indices.length - 1] + 1;
        const pages = await pdf.copyPages(pdf, indices);
        pages.forEach((p, i) => pdf.insertPage(at + i, p));
        mapping = mapping.map((i) => (i! >= at ? i! + pages.length : i));
      }
    }
    const nextBytes = await pdf.save();
    const historyToken = randomUUID();
    d.history.set(historyToken, { bytes: d.bytes, pages: d.pages });
    d.bytes = nextBytes;
    // pdf-lib keeps a stale getPages cache after removal. Re-read committed
    // bytes so metadata reflects the actual PDF page tree.
    d.pages = meta(await PDFDocument.load(nextBytes));
    d.revision++;
    d.ocr.clear();
    d.ocrDirty = false;
    this.trimHistory(d);
    return { ...this.payload(d), pageMapping: mapping, historyToken, retainedHistoryTokens: [...d.history.keys()] };
  }
  // Per-document retention: at most 20 snapshots and 64 MiB of PDF bytes.
  // A snapshot larger than the budget is immediately evicted; the returned
  // token list lets the renderer remove the matching undo boundary.
  private trimHistory(d: DocumentState) {
    let bytes = [...d.history.values()].reduce((sum, item) => sum + item.bytes.length, 0);
    while (d.history.size > 20 || bytes > 64 * 1024 * 1024) {
      const token = d.history.keys().next().value!;
      bytes -= d.history.get(token)!.bytes.length;
      d.history.delete(token);
    }
  }
  private async images(a: Record<string, unknown>) {
    if (!Array.isArray(a.paths) || a.paths.length < 1 || a.paths.length > 100)
      throw new Error("Select 1–100 images");
    let name =
      typeof a.name === "string"
        ? a.name
            .trim()
            .replace(/\.pdf$/i, "")
            .trim()
        : "";
    name = name || "이미지 모음";
    if (/[\x00-\x1f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name))
      throw new Error("Invalid PDF name");
    const pdf = await PDFDocument.create();
    let total = 0;
    for (const source of a.paths) {
      const path = pathArg(source);
      if (!/\.(png|jpe?g)$/i.test(path))
        throw new Error("Only PNG and JPEG supported");
      const info = await stat(path);
      if (!info.isFile() || info.size > 200 * 1024 * 1024 - total)
        throw new Error("Images exceed 200MB");
      const chunks: Buffer[] = [];
      let readBytes = 0;
      for await (const chunk of createReadStream(path)) {
        readBytes += chunk.length;
        if (readBytes > 200 * 1024 * 1024 - total)
          throw new Error("Images exceed 200MB");
        chunks.push(chunk as Buffer);
      }
      const bytes = Buffer.concat(chunks);
      total += bytes.length;
      if (total > 200 * 1024 * 1024) throw new Error("Images exceed 200MB");
      const png = bytes[0] === 137 && bytes[1] === 80;
      const jpg = bytes[0] === 255 && bytes[1] === 216;
      if (!png && !jpg) throw new Error("Invalid image format");
      let orientation = 1;
      if (jpg) {
        const exifr = await import("exifr");
        orientation = (await exifr.orientation(bytes)) ?? 1;
      }
      if (
        png &&
        (bytes.length < 24 ||
          bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 50_000_000 ||
          bytes.readUInt32BE(16) === 0 ||
          bytes.readUInt32BE(20) === 0)
      )
        throw new Error("Image exceeds 50 million pixels or is invalid");
      const image = png ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      if (image.width * image.height > 50_000_000)
        throw new Error("Image exceeds 50 million pixels");
      const sideways = orientation >= 5;
      const w = sideways ? image.height : image.width,
        h = sideways ? image.width : image.height;
      const [pw, ph] = w > h ? [841.8898, 595.2756] : [595.2756, 841.8898];
      const page = pdf.addPage([pw, ph]);
      const scale = Math.min((pw - 56.6929) / w, (ph - 56.6929) / h);
      const x = (pw - w * scale) / 2,
        y = (ph - h * scale) / 2;
      const matrices: Record<number, number[]> = {
        1: [1, 0, 0, 1, 0, 0],
        2: [-1, 0, 0, 1, image.width, 0],
        3: [-1, 0, 0, -1, image.width, image.height],
        4: [1, 0, 0, -1, 0, image.height],
        5: [0, 1, 1, 0, 0, 0],
        6: [0, -1, 1, 0, 0, image.width],
        7: [0, -1, -1, 0, image.height, image.width],
        8: [0, 1, -1, 0, image.height, 0],
      };
      const {
        pushGraphicsState,
        popGraphicsState,
        concatTransformationMatrix,
      } = await import("pdf-lib");
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(scale, 0, 0, scale, x, y),
        concatTransformationMatrix(
          ...(matrices[orientation] as [
            number,
            number,
            number,
            number,
            number,
            number,
          ]),
        ),
      );
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
      page.pushOperators(popGraphicsState());
    }
    return this.register(
      `unsaved://${randomUUID()}/${name}.pdf`,
      await pdf.save(),
      "",
    );
  }
  async dispose() {
    await this.tail;
    for (const d of this.documents.values()) await this.flush(d);
    this.documents.clear();
    this.clipboard = null;
    this.disposed = true;
    await this.ocr.dispose();
  }
}
