import { invoke } from "../platform/desktop";
import { createStore } from "solid-js/store";

export type OcrPageStatus = "idle" | "queued" | "running" | "done" | "error";

interface DocOcrState {
  /** PDF generation these page-indexed results belong to. */
  revision: number;
  /** indices already OCR'd (from sidecar or previous run) */
  done: Set<number>;
  /** indices currently in queue */
  queued: Set<number>;
  /** currently processing index, if any */
  current: number | null;
  /** last error message if any */
  error: string | null;
  failures: Record<number, string>;
  /** total pages in this doc */
  total: number;
}

interface OcrState {
  byDoc: Record<string, DocOcrState>;
}

const [ocrState, setOcrState] = createStore<OcrState>({ byDoc: {} });
export { ocrState };

const initDoc = (docId: string, revision: number, total: number) => {
  if (!ocrState.byDoc[docId] || ocrState.byDoc[docId].revision !== revision) {
    if (activeRun?.docId === docId) activeRun = null;
    setOcrState("byDoc", docId, {
      revision,
      done: new Set(),
      queued: new Set(),
      current: null,
      error: null,
      failures: {},
      total,
    });
  } else {
    setOcrState("byDoc", docId, "total", total);
  }
};

export async function refreshOcrStatus(
  docId: string,
  revision: number,
  total: number,
): Promise<void> {
  initDoc(docId, revision, total);
  try {
    const { ocrPdfStatus } = await import("../ipc/pdf");
    const indices = await ocrPdfStatus(docId, revision);
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

interface ActiveOcrRun {
  id: symbol;
  docId: string;
}

let activeRun: ActiveOcrRun | null = null;

const isActiveRun = (docId: string, runId: symbol): boolean =>
  activeRun?.docId === docId && activeRun.id === runId;

const clearRunningProgress = (docId: string): void => {
  if (!ocrState.byDoc[docId]) return;
  setOcrState("byDoc", docId, (state) => ({
    ...state,
    queued: new Set(),
    current: null,
  }));
};

const supersedeActiveRun = (): void => {
  const previous = activeRun;
  activeRun = null;
  if (previous) clearRunningProgress(previous.docId);
};

/** Drop OCR progress whose boxes were measured against an older page layout. */
export function invalidateOcrForDocument(
  docId: string,
  revision: number,
  total: number,
): void {
  if (activeRun?.docId === docId) activeRun = null;
  setOcrState("byDoc", docId, {
    revision,
    done: new Set(),
    queued: new Set(),
    current: null,
    error: null,
    failures: {},
    total,
  });
}

/**
 * Run OCR over all pages that don't have a result yet. One page at a time —
 * serial dispatch keeps worker memory bounded and progress predictable.
 */
interface OcrBackend {
  recognize(docId: string, revision: number, page: number): Promise<unknown>;
  flush(docId: string, revision: number): Promise<unknown>;
}
const backend: OcrBackend = {
  recognize: async (...args) =>
    (await import("../ipc/pdf")).ocrPdfPage(...args),
  flush: (docId, expectedRevision) =>
    invoke("pdf_ocr_flush", { docId, expectedRevision }),
};

export async function runOcrAll(
  docId: string,
  expectedRevision: number,
  totalPages: number,
  service: OcrBackend = backend,
): Promise<void> {
  return runOcrTargets(docId, expectedRevision, totalPages, null, service);
}

export async function runOcrPage(
  docId: string,
  revision: number,
  total: number,
  page: number,
  service: OcrBackend = backend,
): Promise<void> {
  if (!Number.isInteger(page) || page < 0 || page >= total) return;
  return runOcrTargets(docId, revision, total, page, service);
}

async function runOcrTargets(
  docId: string,
  expectedRevision: number,
  totalPages: number,
  page: number | null,
  service: OcrBackend,
): Promise<void> {
  initDoc(docId, expectedRevision, totalPages);
  // Only one whole-document run owns the UI at a time. Starting another run
  // clears the old document's busy indicator; an already-running backend
  // request may still finish, but revision checks prevent stale publication.
  supersedeActiveRun();
  const runId = Symbol("ocr-run");
  activeRun = { id: runId, docId };

  const targets: number[] = [];
  for (let i = 0; i < totalPages; i++) {
    if ((page === null || i === page) && !ocrState.byDoc[docId]?.done.has(i))
      targets.push(i);
  }
  setOcrState("byDoc", docId, "queued", new Set(targets));
  setOcrState("byDoc", docId, "error", null);

  try {
    for (const idx of targets) {
      if (
        !isActiveRun(docId, runId) ||
        ocrState.byDoc[docId]?.revision !== expectedRevision
      )
        return; // cancelled or superseded by another document generation
      setOcrState("byDoc", docId, "current", idx);
      try {
        await service.recognize(docId, expectedRevision, idx);
        // A structural page edit (including rotation) cancels the run while
        // the platform OCR request may still be finishing. Do not advertise
        // that now-stale result as valid in the UI.
        if (
          !isActiveRun(docId, runId) ||
          ocrState.byDoc[docId]?.revision !== expectedRevision
        )
          return;
        setOcrState("byDoc", docId, "failures", idx, undefined!);
        setOcrState("byDoc", docId, (s) => ({
          ...s,
          done: new Set([...s.done, idx]),
          queued: new Set([...s.queued].filter((q) => q !== idx)),
        }));
      } catch (error) {
        if (
          !isActiveRun(docId, runId) ||
          ocrState.byDoc[docId]?.revision !== expectedRevision
        )
          return;
        const msg = error instanceof Error ? error.message : String(error);
        setOcrState("byDoc", docId, "error", msg);
        setOcrState("byDoc", docId, "failures", idx, msg);
        console.error("ocr page failed", idx, error);
        // Keep going — one bad page shouldn't abort the whole document.
        setOcrState("byDoc", docId, (s) => ({
          ...s,
          queued: new Set([...s.queued].filter((q) => q !== idx)),
        }));
      }
    }
  } finally {
    try {
      await service.flush(docId, expectedRevision);
    } catch (error) {
      console.error("OCR flush failed", error);
    }
  }

  if (isActiveRun(docId, runId)) {
    setOcrState("byDoc", docId, "current", null);
    activeRun = null;
  }
}

export function cancelOcr() {
  supersedeActiveRun();
}

export function getDocProgress(docId: string): {
  done: number;
  total: number;
  current: number | null;
  error: string | null;
  failures: Record<number, string>;
} | null {
  const s = ocrState.byDoc[docId];
  if (!s) return null;
  return {
    done: s.done.size,
    total: s.total,
    current: s.current,
    error: s.error,
    failures: s.failures,
  };
}
