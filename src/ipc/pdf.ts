import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import {
  annotationStore,
  markAnnotationsSaved,
  replaceAnnotations,
  setAnnotationSaveStatus,
} from "../annotations/store";
import type { Annotation, AnnotationSidecar } from "../annotations/types";
import { documentStore, setDocumentStore } from "../state/document";
import type { OpenDocument } from "../state/document";

const makeSidecar = (sourcePath: string, annotations: Annotation[]): AnnotationSidecar => ({
  version: 1,
  sourcePath,
  updatedAt: new Date().toISOString(),
  annotations,
});

interface OpenedDocPayload {
  id: string;
  path: string;
  pageCount: number;
  pages: { index: number; width: number; height: number }[];
  fileSize: number;
}

// Below this file size we eagerly render every page in the background as soon
// as the document opens — that way pages are already in the LRU cache by the
// time the user scrolls there, with no flicker. Larger files fall back to
// on-demand rendering near the viewport.
const EAGER_PREFETCH_LIMIT_BYTES = 30 * 1024 * 1024;

export type DirtyChoice = "save" | "discard" | "cancel";

export async function flushAnnotationSave(): Promise<void> {
  const doc = documentStore.doc;
  if (!doc || !annotationStore.dirty) {
    return;
  }
  try {
    setAnnotationSaveStatus("saving");
    const sidecar = makeSidecar(doc.path, annotationStore.items);
    await saveAnnotationSidecar(doc.path, sidecar);
    markAnnotationsSaved();
  } catch (error) {
    console.error("flush annotation save failed", error);
    throw error;
  }
}

export async function promptUnsavedChanges(
  message = "저장하지 않은 변경사항이 있습니다. 저장하시겠습니까?",
): Promise<DirtyChoice> {
  if (!annotationStore.dirty) {
    return "discard";
  }
  try {
    const result = await ask(message, {
      title: "rustpdf",
      kind: "warning",
      okLabel: "저장",
      cancelLabel: "저장 안 함",
    });
    return result ? "save" : "discard";
  } catch (error) {
    console.error("dirty prompt failed", error);
    const proceed = window.confirm(`${message}\n\n확인 = 저장 / 취소 = 저장 안 함`);
    return proceed ? "save" : "discard";
  }
}

export async function guardUnsavedChanges(): Promise<boolean> {
  const choice = await promptUnsavedChanges();
  if (choice === "cancel") {
    return false;
  }
  if (choice === "save") {
    try {
      await flushAnnotationSave();
    } catch (error) {
      console.error("save before action failed", error);
      const force = window.confirm(
        "저장에 실패했습니다. 그래도 계속하시겠습니까?",
      );
      return force;
    }
  }
  return true;
}

export async function openPdf(path: string): Promise<void> {
  setDocumentStore({ loading: true, error: null });
  try {
    const payload = await invoke<OpenedDocPayload>("pdf_open", { path });
    const doc: OpenDocument = {
      id: payload.id,
      path: payload.path,
      pageCount: payload.pageCount,
      pages: payload.pages,
      fileSize: payload.fileSize,
      prefetchPolicy:
        payload.fileSize <= EAGER_PREFETCH_LIMIT_BYTES ? "all" : "lazy",
    };
    setDocumentStore({
      doc,
      currentPage: 0,
      zoom: 1,
      rotation: 0,
      loading: false,
    });
    try {
      const sidecar = await loadAnnotationSidecar(payload.path);
      replaceAnnotations(sidecar?.annotations ?? [], payload.path);
    } catch (error) {
      console.error("load annotation sidecar failed", error);
      replaceAnnotations([], payload.path);
    }
  } catch (e) {
    setDocumentStore({
      loading: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function openPdfDialog(): Promise<void> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof selected === "string") {
    await openPdf(selected);
  }
}

export async function requestOpenPdfDialog(): Promise<void> {
  const proceed = await guardUnsavedChanges();
  if (!proceed) {
    return;
  }
  await openPdfDialog();
}

export async function requestOpenPdf(path: string): Promise<void> {
  const proceed = await guardUnsavedChanges();
  if (!proceed) {
    return;
  }
  await openPdf(path);
}

export async function closePdf(docId: string): Promise<void> {
  await invoke("pdf_close", { docId });
}

/**
 * Render a single page. Backend uses Tauri's raw `Response` payload so the
 * bytes flow as a real ArrayBuffer (no JSON serialize / deserialize), which
 * is the bulk of the perceived first-paint latency for big pages.
 */
export async function renderPage(
  docId: string,
  pageIndex: number,
  scale: number,
  rotation: number
): Promise<ArrayBuffer> {
  const result = await invoke<ArrayBuffer | Uint8Array | number[]>(
    "pdf_render_page",
    { docId, pageIndex, scale, rotation }
  );
  if (result instanceof ArrayBuffer) return result;
  if (result instanceof Uint8Array) {
    return result.buffer.slice(
      result.byteOffset,
      result.byteOffset + result.byteLength
    );
  }
  // Legacy fallback: JSON-encoded number[]
  return new Uint8Array(result).buffer;
}

export interface SearchHit {
  page: number;
  start: number;
  length: number;
  snippet: string;
}

export async function searchPdf(
  docId: string,
  query: string
): Promise<SearchHit[]> {
  return await invoke<SearchHit[]>("pdf_search", { docId, query });
}

export async function loadAnnotationSidecar(
  path: string
): Promise<AnnotationSidecar | null> {
  return await invoke<AnnotationSidecar | null>("annotations_load", { path });
}

export async function saveAnnotationSidecar(
  path: string,
  data: AnnotationSidecar
): Promise<void> {
  await invoke("annotations_save", { path, data });
}

export async function initialOpenPath(): Promise<string | null> {
  return await invoke<string | null>("initial_open_path");
}

export async function exportAnnotatedPdfFile(): Promise<void> {
  const doc = documentStore.doc;
  if (!doc) {
    return;
  }

  const target = await save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath: doc.path.replace(/\.pdf$/i, ".annotated.pdf"),
  });
  if (!target) {
    return;
  }

  const data: AnnotationSidecar = {
    version: 1,
    sourcePath: doc.path,
    updatedAt: new Date().toISOString(),
    annotations: annotationStore.items,
  };
  await invoke("export_annotated_pdf", {
    sourcePath: doc.path,
    targetPath: target,
    data,
  });
}
