import { invoke } from "../platform/desktop";
import { pdfEngine } from "../platform/pdf-engine";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

export type OcrPageStatus = "idle" | "queued" | "running" | "done" | "error";

interface DocOcrState {
  /** PDF generation these page-indexed results belong to. */
  revision: number;
  /** indices already OCR'd (from the cache or a previous run) */
  done: Set<number>;
  /** page indices still pending in this document's active run */
  queued: Set<number>;
  /** the document's run is waiting behind another document's run */
  waiting: boolean;
  /** currently processing index, if any */
  current: number | null;
  /** last error message if any */
  error: string | null;
  failures: Record<number, string>;
  /** pages skipped by the last whole-document run because they have text */
  skipped: number;
  /** total pages in this doc */
  total: number;
}

interface OcrState {
  byDoc: Record<string, DocOcrState>;
}

const [ocrState, setOcrState] = createStore<OcrState>({ byDoc: {} });
export { ocrState };

const STORAGE_KEY = "rustpdf.ocr.includeOnSave";
const readIncludeOnSave = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
};
const [includeOnSave, setIncludeOnSaveSignal] = createSignal(
  readIncludeOnSave(),
);
export const includeOcrOnSave = (): boolean => includeOnSave();
export function setIncludeOcrOnSave(value: boolean): void {
  setIncludeOnSaveSignal(value);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(value));
  } catch {
    // Persisting is best effort.
  }
}

export interface OcrBackend {
  recognize(docId: string, revision: number, page: number): Promise<unknown>;
  hasText(docId: string, revision: number, page: number): Promise<boolean>;
  status(docId: string, revision: number): Promise<number[]>;
  flush(docId: string, revision: number): Promise<unknown>;
}
const defaultBackend: OcrBackend = {
  recognize: (d, r, p) => pdfEngine().recognizePage(d, r, p),
  hasText: (d, r, p) => pdfEngine().pageHasText(d, r, p),
  status: (docId, expectedRevision) =>
    invoke<number[]>("pdf_ocr_status", { docId, expectedRevision }),
  flush: (docId, expectedRevision) =>
    invoke("pdf_ocr_flush", { docId, expectedRevision }),
};

const freshState = (revision: number, total: number): DocOcrState => ({
  revision,
  done: new Set(),
  queued: new Set(),
  waiting: false,
  current: null,
  error: null,
  failures: {},
  skipped: 0,
  total,
});

const initDoc = (docId: string, revision: number, total: number) => {
  if (!ocrState.byDoc[docId] || ocrState.byDoc[docId].revision !== revision) {
    dropRuns(docId);
    setOcrState("byDoc", docId, freshState(revision, total));
  } else {
    setOcrState("byDoc", docId, "total", total);
  }
};

export async function refreshOcrStatus(
  docId: string,
  revision: number,
  total: number,
  service: OcrBackend = defaultBackend,
): Promise<void> {
  initDoc(docId, revision, total);
  try {
    const indices = await service.status(docId, revision);
    if (ocrState.byDoc[docId]?.revision !== revision) return;
    setOcrState(
      "byDoc",
      docId,
      "done",
      new Set([...ocrState.byDoc[docId].done, ...indices]),
    );
  } catch (error) {
    console.error("ocr status failed", error);
  }
}

interface OcrRun {
  docId: string;
  revision: number;
  total: number;
  /** null = whole document */
  page: number | null;
  service: OcrBackend;
  cancelled: boolean;
  finish: () => void;
}

/** Global FIFO of runs; at most one is active. */
const pending: OcrRun[] = [];
let activeRun: OcrRun | null = null;

const clearProgress = (docId: string): void => {
  if (!ocrState.byDoc[docId]) return;
  setOcrState("byDoc", docId, (state) => ({
    ...state,
    queued: new Set(),
    waiting: false,
    current: null,
  }));
};

/** Remove the doc's queued runs and stop its active run after this page. */
function dropRuns(docId: string): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].docId !== docId) continue;
    const [run] = pending.splice(i, 1);
    run.cancelled = true;
    run.finish();
  }
  if (activeRun?.docId === docId) activeRun.cancelled = true;
  clearProgress(docId);
}

/** Drop OCR progress whose boxes were measured against an older page layout. */
export function invalidateOcrForDocument(
  docId: string,
  revision: number,
  total: number,
  service: OcrBackend = defaultBackend,
): void {
  dropRuns(docId);
  setOcrState("byDoc", docId, freshState(revision, total));
  // The worker keeps remapped OCR across page edits (spec 2.13).
  void refreshOcrStatus(docId, revision, total, service);
}

const stale = (run: OcrRun): boolean =>
  run.cancelled || ocrState.byDoc[run.docId]?.revision !== run.revision;

async function execute(run: OcrRun): Promise<void> {
  const { docId, revision, service } = run;
  const targets: number[] = [];
  for (let i = 0; i < run.total; i++) {
    if ((run.page === null || i === run.page) && !ocrState.byDoc[docId]?.done.has(i))
      targets.push(i);
  }
  setOcrState("byDoc", docId, (s) => ({
    ...s,
    waiting: false,
    queued: new Set(targets),
    error: null,
    skipped: 0,
  }));
  try {
    for (const idx of targets) {
      if (stale(run)) return;
      if (run.page === null) {
        let hasText = false;
        try {
          hasText = await service.hasText(docId, revision, idx);
        } catch {
          hasText = false;
        }
        if (stale(run)) return;
        if (hasText) {
          setOcrState("byDoc", docId, (s) => ({
            ...s,
            skipped: s.skipped + 1,
            queued: new Set([...s.queued].filter((q) => q !== idx)),
          }));
          continue;
        }
      }
      setOcrState("byDoc", docId, "current", idx);
      try {
        await service.recognize(docId, revision, idx);
        if (stale(run)) return;
        setOcrState("byDoc", docId, "failures", idx, undefined!);
        setOcrState("byDoc", docId, (s) => ({
          ...s,
          done: new Set([...s.done, idx]),
          queued: new Set([...s.queued].filter((q) => q !== idx)),
        }));
      } catch (error) {
        if (stale(run)) return;
        const msg = error instanceof Error ? error.message : String(error);
        setOcrState("byDoc", docId, "error", msg);
        setOcrState("byDoc", docId, "failures", idx, msg);
        console.error("ocr page failed", idx, error);
        // One bad page must not abort the whole document.
        setOcrState("byDoc", docId, (s) => ({
          ...s,
          queued: new Set([...s.queued].filter((q) => q !== idx)),
        }));
      }
    }
  } finally {
    try {
      await service.flush(docId, revision);
    } catch (error) {
      console.error("OCR flush failed", error);
    }
    if (ocrState.byDoc[docId]?.revision === revision && !run.cancelled)
      setOcrState("byDoc", docId, (s) => ({
        ...s,
        queued: new Set(),
        current: null,
      }));
  }
}

async function pump(): Promise<void> {
  if (activeRun) return;
  const run = pending.shift();
  if (!run) return;
  activeRun = run;
  try {
    await execute(run);
  } finally {
    activeRun = null;
    run.finish();
    void pump();
  }
}

function enqueue(
  docId: string,
  revision: number,
  total: number,
  page: number | null,
  service: OcrBackend,
): Promise<void> {
  initDoc(docId, revision, total);
  // Starting a document that is already queued or active is a no-op.
  if (
    (activeRun?.docId === docId && !activeRun.cancelled) ||
    pending.some((r) => r.docId === docId))
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const run: OcrRun = {
      docId,
      revision,
      total,
      page,
      service,
      cancelled: false,
      finish: resolve,
    };
    pending.push(run);
    if (activeRun) setOcrState("byDoc", docId, "waiting", true);
    void pump();
  });
}

/** Whole-document run; pages that already contain text are skipped. */
export function runOcrAll(
  docId: string,
  expectedRevision: number,
  totalPages: number,
  service: OcrBackend = defaultBackend,
): Promise<void> {
  return enqueue(docId, expectedRevision, totalPages, null, service);
}

/** Explicit single-page run; never skips pages with text. */
export function runOcrPage(
  docId: string,
  revision: number,
  total: number,
  page: number,
  service: OcrBackend = defaultBackend,
): Promise<void> {
  if (!Number.isInteger(page) || page < 0 || page >= total)
    return Promise.resolve();
  return enqueue(docId, revision, total, page, service);
}

/** Remove a document's queued run, or stop its active run after this page. */
export function cancelOcr(docId?: string): void {
  if (docId !== undefined) {
    dropRuns(docId);
    return;
  }
  if (activeRun) {
    activeRun.cancelled = true;
    clearProgress(activeRun.docId);
  }
}

export function getDocProgress(docId: string): {
  done: number;
  total: number;
  current: number | null;
  error: string | null;
  failures: Record<number, string>;
  waiting: boolean;
  skipped: number;
} | null {
  const s = ocrState.byDoc[docId];
  if (!s) return null;
  return {
    done: s.done.size,
    total: s.total,
    current: s.current,
    error: s.error,
    failures: s.failures,
    waiting: s.waiting,
    skipped: s.skipped,
  };
}
