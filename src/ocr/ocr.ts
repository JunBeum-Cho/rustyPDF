import { createStore } from "solid-js/store";
import { ocrPdfPage, ocrPdfStatus } from "../ipc/pdf";

export type OcrPageStatus = "idle" | "queued" | "running" | "done" | "error";

interface DocOcrState {
  /** indices already OCR'd (from sidecar or previous run) */
  done: Set<number>;
  /** indices currently in queue */
  queued: Set<number>;
  /** currently processing index, if any */
  current: number | null;
  /** last error message if any */
  error: string | null;
  /** total pages in this doc */
  total: number;
}

interface OcrState {
  byDoc: Record<string, DocOcrState>;
}

const [ocrState, setOcrState] = createStore<OcrState>({ byDoc: {} });
export { ocrState };

const initDoc = (docId: string, total: number) => {
  if (!ocrState.byDoc[docId]) {
    setOcrState("byDoc", docId, {
      done: new Set(),
      queued: new Set(),
      current: null,
      error: null,
      total,
    });
  } else {
    setOcrState("byDoc", docId, "total", total);
  }
};

export async function refreshOcrStatus(
  docId: string,
  total: number,
): Promise<void> {
  initDoc(docId, total);
  try {
    const indices = await ocrPdfStatus(docId);
    setOcrState("byDoc", docId, "done", new Set(indices));
  } catch (error) {
    console.error("ocr status failed", error);
  }
}

let activeRunId: symbol | null = null;

/**
 * Run OCR over all pages that don't have a result yet. One page at a time —
 * the platform helpers (Vision / Windows.Media.Ocr) are themselves serial,
 * and serial dispatch keeps the system responsive.
 */
export async function runOcrAll(
  docId: string,
  totalPages: number,
): Promise<void> {
  initDoc(docId, totalPages);
  const runId = Symbol("ocr-run");
  activeRunId = runId;

  const targets: number[] = [];
  for (let i = 0; i < totalPages; i++) {
    if (!ocrState.byDoc[docId]?.done.has(i)) targets.push(i);
  }
  setOcrState("byDoc", docId, "queued", new Set(targets));
  setOcrState("byDoc", docId, "error", null);

  for (const idx of targets) {
    if (activeRunId !== runId) return; // cancelled by another run
    setOcrState("byDoc", docId, "current", idx);
    try {
      await ocrPdfPage(docId, idx);
      setOcrState("byDoc", docId, (s) => ({
        ...s,
        done: new Set([...s.done, idx]),
        queued: new Set([...s.queued].filter((q) => q !== idx)),
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setOcrState("byDoc", docId, "error", msg);
      console.error("ocr page failed", idx, error);
      // Keep going — one bad page shouldn't abort the whole document.
      setOcrState("byDoc", docId, (s) => ({
        ...s,
        queued: new Set([...s.queued].filter((q) => q !== idx)),
      }));
    }
  }

  if (activeRunId === runId) {
    setOcrState("byDoc", docId, "current", null);
    activeRunId = null;
  }
}

export function cancelOcr() {
  activeRunId = null;
}

export function getDocProgress(
  docId: string,
): { done: number; total: number; current: number | null; error: string | null } | null {
  const s = ocrState.byDoc[docId];
  if (!s) return null;
  return {
    done: s.done.size,
    total: s.total,
    current: s.current,
    error: s.error,
  };
}
