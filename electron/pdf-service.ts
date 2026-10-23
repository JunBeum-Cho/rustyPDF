import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import type { Annotation } from "../src/annotations/types.js";
import { loadLegacy } from "./annotation-store.js";
import { createPdfFromImages } from "./image-pdf.js";
import { DiskWatcher } from "./disk-watch.js";
import { flattenPdf } from "./export.js";
import { OcrEngine, validOcrPage } from "./ocr.js";
import { addOcrTextLayer } from "./ocr-export.js";
import { OcrCache, remapOcr } from "./ocr-store.js";
import {
  applyPageEdit,
  extractPages,
  mergePdfFiles,
  pageMeta,
  type PageEdit,
} from "./page-ops.js";
import { readAnnotations, stripAnnotations, writeAnnotations } from "./pdf-annotations.js";
import type {
  DocumentState,
  HistoryEntry,
  OcrPage,
  PageMeta,
  PdfServiceEmit,
  PdfServiceOptions,
} from "./pdf-types.js";
import { atomicWrite, fingerprint, sameFile } from "./storage.js";

export const READ_ONLY_MESSAGE =
  "암호화된 PDF는 읽기 전용이라 편집하거나 저장할 수 없습니다.";
const MAX_HISTORY = 20;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MUTATING = new Set([
  "pdf_delete_pages",
  "pdf_duplicate_pages",
  "pdf_rotate_pages",
  "pdf_move_pages",
  "pdf_paste_pages",
  "pdf_insert_file",
  "pdf_apply_form_bytes",
  "pdf_save_document",
  "export_annotated_pdf",
  "pdf_flatten_bytes",
]);

function pathArg(value: unknown) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))
    throw new Error("올바른 파일 경로가 아닙니다.");
  return value;
}
function sidecarArg(value: unknown) {
  const data = value as { annotations?: unknown } | null;
  if (!data || typeof data !== "object" || !Array.isArray(data.annotations))
    throw new Error("주석 데이터가 올바르지 않습니다.");
  return data as { annotations: Annotation[] };
}
/** True when any signature field has a value or the AcroForm says it is signed. */
function isSigned(pdf: PDFDocument) {
  const form = pdf.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  const flags = form?.lookupMaybe(PDFName.of("SigFlags"), PDFNumber);
  if (flags && flags.asNumber() > 0) return true;
  for (const [, object] of pdf.context.enumerateIndirectObjects())
    if (
      object instanceof PDFDict &&
      object.get(PDFName.of("FT")) === PDFName.of("Sig") &&
      object.has(PDFName.of("V"))
    )
      return true;
  return false;
}
function copyOcr(pages: ReadonlyMap<number, OcrPage>) {
  return new Map(
    [...pages].map(([index, page]) => [
      index,
      { text: page.text, lines: page.lines.map((line) => ({ ...line })) },
    ]),
  );
}

export class PdfService {
  private documents = new Map<string, DocumentState>();
  private ocr: OcrEngine;
  private cache: OcrCache;
  private watcher: DiskWatcher;
  private clipboard: { id: string; bytes: Uint8Array } | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(
    private options: PdfServiceOptions,
    private emit?: PdfServiceEmit,
  ) {
    this.ocr = new OcrEngine(options.dataDir, options.assetsDir);
    this.cache = new OcrCache(options.dataDir);
    this.watcher = new DiskWatcher((docId) =>
      this.emit?.("document-changed-on-disk", { docId }),
    );
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
      readOnly: d.readOnly,
      readOnlyReason: d.readOnlyReason,
      signed: d.signed,
    };
  }
  private async unchanged(d: DocumentState, path = d.path) {
    if (!(await sameFile(d.path, path))) return;
    let disk;
    try {
      disk = await readFile(path);
    } catch {
      throw new Error("원본 PDF 파일을 찾을 수 없습니다. 다른 이름으로 저장해 주세요.");
    }
    if (fingerprint(disk) !== d.diskFingerprint)
      throw new Error(
        "다른 프로그램이 이 PDF를 수정했습니다. 파일을 다시 불러온 뒤 저장해 주세요.",
      );
  }
  private async conflict(path: string, except?: string) {
    for (const d of this.documents.values())
      if (d.id !== except && (await sameFile(d.path, path)))
        throw new Error("다른 문서로 열려 있는 PDF에는 저장할 수 없습니다.");
  }
  private indices(a: Record<string, unknown>, count: number) {
    if (
      !Array.isArray(a.indices) ||
      !a.indices.length ||
      a.indices.some((i) => !Number.isInteger(i) || i < 0 || i >= count)
    )
      throw new Error("페이지 번호가 올바르지 않습니다.");
    return [...new Set(a.indices as number[])].sort((x, y) => x - y);
  }
  private pageIndex(a: Record<string, unknown>, d: DocumentState) {
    if (
      !Number.isInteger(a.pageIndex) ||
      Number(a.pageIndex) < 0 ||
      Number(a.pageIndex) >= d.pages.length
    )
      throw new Error("페이지 번호가 올바르지 않습니다.");
    return Number(a.pageIndex);
  }
  /** Cache write failures are logged and never block close or dispose. */
  private async flush(d: DocumentState) {
    if (!d.ocrDirty) return;
    try {
      await this.cache.save(fingerprint(d.bytes), d.ocr);
      d.ocrDirty = false;
    } catch (error) {
      console.error("OCR cache write failed", error);
    }
  }
  private async register(
    path: string,
    base: Uint8Array,
    pages: PageMeta[],
    diskFingerprint: string,
    flags: { readOnly: boolean; signed: boolean },
  ) {
    const d: DocumentState = {
      id: randomUUID(),
      path,
      revision: 0,
      bytes: base,
      diskFingerprint,
      pages,
      ocr: new Map(),
      ocrDirty: false,
      history: new Map(),
      readOnly: flags.readOnly,
      readOnlyReason: flags.readOnly ? "encrypted" : null,
      signed: flags.signed,
    };
    try {
      const cached = await this.cache.load(
        fingerprint(base),
        pages.length,
        path.startsWith("unsaved://") ? undefined : path,
      );
      for (const [index, page] of cached)
        if (index < pages.length && validOcrPage(page)) d.ocr.set(index, page);
    } catch (error) {
      console.error("OCR cache read failed", error);
    }
    this.documents.set(d.id, d);
    if (!path.startsWith("unsaved://"))
      this.watcher.watch(d.id, path, diskFingerprint);
    return d;
  }
  private async registerUnsaved(bytes: Uint8Array, name: unknown) {
    let title = typeof name === "string" ? name.trim().replace(/\.pdf$/i, "").trim() : "";
    title = title || "새 문서";
    if (/[\x00-\x1f<>:"/\\|?*]/.test(title) || /[. ]$/.test(title))
      throw new Error("PDF 이름이 올바르지 않습니다.");
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    if (!pdf.getPageCount()) throw new Error("페이지가 없는 PDF입니다.");
    const d = await this.register(
      `unsaved://${randomUUID()}/${title}.pdf`,
      bytes,
      pageMeta(pdf),
      "",
      { readOnly: false, signed: false },
    );
    return this.payload(d);
  }
  private async open(path: string) {
    for (const d of this.documents.values())
      if (await sameFile(d.path, path))
        return { ...this.payload(d), annotations: null, legacy: null };
    const original = await readFile(path);
    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(original, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
    } catch (error) {
      throw new Error(
        `PDF를 해석할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!pdf.getPageCount()) throw new Error("페이지가 없는 PDF입니다.");
    const readOnly = pdf.isEncrypted;
    const signed = !readOnly && isSigned(pdf);
    let annotations: Annotation[] | null = null;
    let base: Uint8Array = original;
    if (!readOnly) {
      const found = readAnnotations(pdf) as Annotation[];
      if (found.length) {
        stripAnnotations(pdf);
        base = await pdf.save();
        annotations = found;
      }
    }
    const legacy =
      annotations || readOnly
        ? null
        : await loadLegacy(path, original, [
            join(this.options.dataDir, "annotations"),
            ...(this.options.legacyDataDirs ?? []).map((dir) =>
              join(dir, "annotations"),
            ),
          ]).catch(() => null);
    const d = await this.register(
      path,
      base,
      pageMeta(pdf),
      fingerprint(original),
      { readOnly, signed },
    );
    return { ...this.payload(d), annotations, legacy };
  }
  private async dispatch(
    command: string,
    a: Record<string, unknown>,
  ): Promise<any> {
    switch (command) {
      case "pdf_open":
        return this.open(pathArg(a.path));
      case "pdf_create_from_images": {
        if (!Array.isArray(a.paths) || a.paths.length < 1 || a.paths.length > 100)
          throw new Error("이미지를 1~100개 선택해 주세요.");
        return this.registerUnsaved(
          await createPdfFromImages(a.paths.map(pathArg)),
          a.name || "이미지 모음",
        );
      }
      case "pdf_merge_files": {
        if (!Array.isArray(a.paths) || a.paths.length < 2)
          throw new Error("합칠 PDF를 2개 이상 선택해 주세요.");
        return this.registerUnsaved(
          await mergePdfFiles(a.paths.map(pathArg)),
          a.name || "합친 문서",
        );
      }
      case "pdf_close": {
        const d = this.get(a, false);
        try {
          await this.flush(d);
        } finally {
          this.documents.delete(d.id);
          this.watcher.unwatch(d.id);
        }
        return;
      }
    }
    const d = this.get(a);
    if (d.readOnly && MUTATING.has(command)) throw new Error(READ_ONLY_MESSAGE);
    switch (command) {
      case "pdf_restore_snapshot": {
        const token = String(a.token);
        const snapshot = d.history.get(token);
        if (!snapshot) throw new Error("Document history expired");
        d.history.set(token, { bytes: d.bytes, pages: d.pages, ocr: d.ocr });
        d.bytes = snapshot.bytes;
        d.pages = snapshot.pages;
        d.ocr = snapshot.ocr;
        d.ocrDirty = d.ocr.size > 0;
        d.revision++;
        this.trimHistory(d);
        return {
          ...this.payload(d),
          retainedHistoryTokens: [...d.history.keys()],
        };
      }
      case "pdf_document_bytes":
        return d.bytes.slice();
      case "pdf_ocr_status":
        return [...d.ocr.keys()].sort((x, y) => x - y);
      case "pdf_ocr_lines":
        return d.ocr.get(this.pageIndex(a, d))?.lines ?? null;
      case "pdf_ocr_all_lines":
        return Object.fromEntries(
          [...d.ocr].map(([index, page]) => [index, page.lines]),
        );
      case "pdf_ocr_flush":
        await this.flush(d);
        return;
      case "pdf_ocr_page": {
        const index = this.pageIndex(a, d);
        const known = d.ocr.get(index);
        if (known) return known;
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
          throw new Error("OCR 이미지가 올바르지 않습니다.");
        const page = await this.ocr.recognize(
          a.image,
          Number(a.imageWidth),
          Number(a.imageHeight),
        );
        d.ocr.set(index, page);
        d.ocrDirty = true;
        return page;
      }
      case "pdf_copy_pages": {
        const bytes = await extractPages(d.bytes, this.indices(a, d.pages.length));
        if (bytes.length > 200 * 1024 * 1024)
          throw new Error("복사한 페이지가 200MB를 넘습니다.");
        this.clipboard = { id: randomUUID(), bytes };
        return this.clipboard.id;
      }
      case "pdf_extract_pages":
        return this.registerUnsaved(
          await extractPages(d.bytes, this.indices(a, d.pages.length)),
          a.name || "추출한 페이지",
        );
      case "pdf_delete_pages": {
        const indices = this.indices(a, d.pages.length);
        if (indices.length === d.pages.length)
          throw new Error("모든 페이지를 삭제할 수 없습니다.");
        return this.edit(d, { kind: "delete", indices });
      }
      case "pdf_duplicate_pages":
        return this.edit(d, {
          kind: "duplicate",
          indices: this.indices(a, d.pages.length),
        });
      case "pdf_rotate_pages":
        if (a.direction !== 1 && a.direction !== -1)
          throw new Error("회전 방향이 올바르지 않습니다.");
        return this.edit(d, {
          kind: "rotate",
          indices: this.indices(a, d.pages.length),
          direction: a.direction,
        });
      case "pdf_move_pages":
        if (!Number.isInteger(a.toIndex) || Number(a.toIndex) < 0)
          throw new Error("이동 위치가 올바르지 않습니다.");
        return this.edit(d, {
          kind: "move",
          indices: this.indices(a, d.pages.length),
          toIndex: Number(a.toIndex),
        });
      case "pdf_paste_pages": {
        if (!this.clipboard || a.clipboardId !== this.clipboard.id)
          throw new Error("Clipboard expired");
        return this.edit(d, {
          kind: "insert",
          sourceBytes: this.clipboard.bytes,
          afterIndex: this.afterIndex(a, d),
        });
      }
      case "pdf_insert_file": {
        const afterIndex = this.afterIndex(a, d);
        return this.edit(d, {
          kind: "insert",
          sourceBytes: await readFile(pathArg(a.path)),
          afterIndex,
        });
      }
      case "pdf_apply_form_bytes": {
        if (!(a.bytes instanceof Uint8Array) || !a.bytes.length)
          throw new Error("양식 데이터가 올바르지 않습니다.");
        const bytes = a.bytes.slice();
        const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
        if (pdf.getPageCount() !== d.pages.length)
          throw new Error("양식 데이터의 페이지 수가 다릅니다.");
        return this.commit(d, {
          bytes,
          pages: pageMeta(pdf),
          mapping: d.pages.map((_, i) => i),
          rotated: [],
        });
      }
      case "pdf_save_document":
        return this.save(d, a);
      case "export_annotated_pdf": {
        const target = pathArg(a.targetPath);
        const data = sidecarArg(a.data);
        // Completed recognition belongs to this export invocation.
        const ocrPages = copyOcr(d.ocr);
        await this.conflict(target);
        await atomicWrite(
          target,
          await flattenPdf(d.bytes, data, this.options.fontsDir, ocrPages),
        );
        return;
      }
      case "pdf_flatten_bytes":
        return flattenPdf(
          d.bytes,
          sidecarArg(a.data),
          this.options.fontsDir,
          a.includeOcr === true ? copyOcr(d.ocr) : undefined,
        );
      default:
        throw new Error(`Unsupported PDF command: ${command}`);
    }
  }
  private afterIndex(a: Record<string, unknown>, d: DocumentState) {
    if (
      !Number.isInteger(a.afterIndex) ||
      Number(a.afterIndex) < -1 ||
      Number(a.afterIndex) >= d.pages.length
    )
      throw new Error("삽입 위치가 올바르지 않습니다.");
    return Number(a.afterIndex);
  }
  private async save(d: DocumentState, a: Record<string, unknown>) {
    const target = pathArg(a.targetPath);
    const data = sidecarArg(a.annotations);
    if (a.requireCurrentPath === true && !(await sameFile(d.path, target)))
      throw new Error("이 문서는 현재 위치에만 저장할 수 있습니다.");
    await this.conflict(target, d.id);
    await this.unchanged(d, target);
    const pdf = await PDFDocument.load(d.bytes, { updateMetadata: false });
    await writeAnnotations(pdf, data as any, this.options.fontsDir);
    if (a.includeOcr === true && d.ocr.size)
      await addOcrTextLayer(pdf, d.ocr, this.options.fontsDir);
    const written = await pdf.save();
    await this.unchanged(d, target);
    await atomicWrite(target, written);
    d.path = target;
    d.diskFingerprint = fingerprint(written);
    d.revision++;
    this.watcher.update(d.id, target, d.diskFingerprint);
    return this.payload(d);
  }
  private commit(
    d: DocumentState,
    result: {
      bytes: Uint8Array;
      pages: PageMeta[];
      mapping: (number | null)[];
      rotated: number[];
    },
  ) {
    const token = randomUUID();
    d.history.set(token, { bytes: d.bytes, pages: d.pages, ocr: d.ocr });
    d.bytes = result.bytes;
    d.pages = result.pages;
    d.ocr = remapOcr(d.ocr, result.mapping, result.rotated);
    d.ocrDirty = d.ocr.size > 0;
    d.revision++;
    this.trimHistory(d);
    return {
      ...this.payload(d),
      pageMapping: result.mapping,
      historyToken: token,
      retainedHistoryTokens: [...d.history.keys()],
    };
  }
  private async edit(d: DocumentState, op: PageEdit) {
    return this.commit(d, await applyPageEdit(d.bytes, op));
  }
  // Per-document retention: at most 20 snapshots and 64 MiB of PDF bytes.
  private trimHistory(d: DocumentState) {
    let bytes = 0;
    for (const item of d.history.values()) bytes += item.bytes.length;
    while (d.history.size > MAX_HISTORY || bytes > MAX_HISTORY_BYTES) {
      const token = d.history.keys().next().value!;
      bytes -= d.history.get(token)!.bytes.length;
      d.history.delete(token);
    }
  }
  async dispose() {
    await this.tail;
    try {
      for (const d of this.documents.values()) await this.flush(d);
    } finally {
      this.documents.clear();
      this.clipboard = null;
      this.disposed = true;
      this.watcher.dispose();
      await this.ocr.dispose().catch(() => {});
    }
  }
}
export type { HistoryEntry };
