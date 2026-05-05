import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { emitToast } from "../capture/capture";
import {
  annotationStore,
  markAnnotationsSavedForTab,
  replaceAnnotationsForTab,
  setAnnotationSaveStatusForTab,
} from "../annotations/store";
import type { Annotation, AnnotationSidecar } from "../annotations/types";
import {
  activeTab,
  documentStore,
  emptyAnnotationTabState,
  fileNameFromPath,
  findTabIndex,
  generateTabId,
  setActiveTab,
  setDocumentStore,
  type Tab,
} from "../state/document";
import { produce } from "solid-js/store";

const makeSidecar = (
  sourcePath: string,
  annotations: Annotation[],
): AnnotationSidecar => ({
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

const EAGER_PREFETCH_LIMIT_BYTES = 30 * 1024 * 1024;

export type DirtyChoice = "save" | "discard" | "cancel";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function flushAnnotationSaveForTab(tabId: string): Promise<void> {
  const idx = findTabIndex(tabId);
  if (idx < 0) return;
  const tab = documentStore.tabs[idx];
  if (!tab.annotations.dirty) return;
  setAnnotationSaveStatusForTab(tabId, "saving");
  const sidecar = makeSidecar(tab.path, tab.annotations.items);
  await saveAnnotationSidecar(tab.path, sidecar);
  markAnnotationsSavedForTab(tabId);
}

export async function flushActiveAnnotationSave(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  await flushAnnotationSaveForTab(tab.tabId);
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
    const proceed = window.confirm(
      `${message}\n\n확인 = 저장 / 취소 = 저장 안 함`,
    );
    return proceed ? "save" : "discard";
  }
}

export async function guardActiveTabUnsaved(): Promise<boolean> {
  const choice = await promptUnsavedChanges();
  if (choice === "cancel") return false;
  if (choice === "save") {
    try {
      await flushActiveAnnotationSave();
    } catch (error) {
      console.error("save before action failed", error);
      return window.confirm("저장에 실패했습니다. 그래도 계속하시겠습니까?");
    }
  }
  return true;
}

const buildTabFromPayload = (payload: OpenedDocPayload): Tab => ({
  tabId: generateTabId(),
  docId: payload.id,
  path: payload.path,
  pageCount: payload.pageCount,
  pages: payload.pages,
  fileSize: payload.fileSize,
  prefetchPolicy:
    payload.fileSize <= EAGER_PREFETCH_LIMIT_BYTES ? "all" : "lazy",
  zoom: 1,
  rotation: 0,
  currentPage: 0,
  selectedPageIndices: [],
  pageAnchor: null,
  pageDirty: false,
  annotations: emptyAnnotationTabState(),
});

/**
 * Open a PDF as a new tab. If the same file is already open, just activate
 * that tab (Acrobat-like behaviour).
 */
export async function openPdf(path: string): Promise<void> {
  const existing = documentStore.tabs.find((t) => t.path === path);
  if (existing) {
    setActiveTab(existing.tabId);
    return;
  }

  setDocumentStore({ loading: true, error: null });
  try {
    const payload = await invoke<OpenedDocPayload>("pdf_open", { path });
    const tab = buildTabFromPayload(payload);
    setDocumentStore(
      produce((state) => {
        state.tabs.push(tab);
        state.activeTabId = tab.tabId;
        state.loading = false;
      }),
    );
    try {
      const sidecar = await loadAnnotationSidecar(payload.path);
      replaceAnnotationsForTab(tab.tabId, sidecar?.annotations ?? []);
    } catch (error) {
      console.error("load annotation sidecar failed", error);
      replaceAnnotationsForTab(tab.tabId, []);
    }
  } catch (e) {
    const message = errorMessage(e);
    setDocumentStore({
      loading: false,
      error: message,
    });
    emitToast(`PDF 열기 실패: ${message}`, "error");
  }
}

export async function openPdfDialog(): Promise<void> {
  let selected: string | string[] | null;
  try {
    selected = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error("open pdf dialog failed", error);
    setDocumentStore({ loading: false, error: message });
    emitToast(`파일 선택 창을 열 수 없습니다: ${message}`, "error");
    return;
  }
  if (Array.isArray(selected)) {
    for (const path of selected) {
      await openPdf(path);
    }
  } else if (typeof selected === "string") {
    await openPdf(selected);
  }
}

export async function requestOpenPdfDialog(): Promise<void> {
  await openPdfDialog();
}

export async function requestOpenPdf(path: string): Promise<void> {
  await openPdf(path);
}

export async function closePdf(docId: string): Promise<void> {
  await invoke("pdf_close", { docId });
}

export async function closeTab(tabId: string): Promise<void> {
  const idx = findTabIndex(tabId);
  if (idx < 0) return;
  const tab = documentStore.tabs[idx];

  if (tab.annotations.dirty || tab.pageDirty) {
    let shouldSave = false;
    try {
      shouldSave = await ask(
        `${fileNameFromPath(tab.path)}에 저장되지 않은 변경사항이 있습니다. 저장하시겠습니까?`,
        {
          title: "rustpdf",
          kind: "warning",
          okLabel: "저장 후 닫기",
          cancelLabel: "저장 안 함",
        },
      );
    } catch {
      shouldSave = window.confirm(
        `${fileNameFromPath(tab.path)}에 저장되지 않은 변경사항이 있습니다. 저장하시겠습니까?`,
      );
    }
    if (shouldSave) {
      try {
        if (tab.annotations.dirty) {
          await flushAnnotationSaveForTab(tab.tabId);
        }
        if (tab.pageDirty) {
          await savePdfToPath(tab.docId, tab.path);
        }
      } catch (error) {
        console.error("close-tab save failed", error);
        const force = window.confirm("저장에 실패했습니다. 그래도 닫으시겠습니까?");
        if (!force) return;
      }
    }
  }

  try {
    await closePdf(tab.docId);
  } catch (error) {
    console.error("backend close failed", error);
  }

  setDocumentStore(
    produce((state) => {
      const removeIdx = state.tabs.findIndex((t) => t.tabId === tabId);
      if (removeIdx < 0) return;
      state.tabs.splice(removeIdx, 1);
      if (state.activeTabId === tabId) {
        const next = state.tabs[Math.min(removeIdx, state.tabs.length - 1)];
        state.activeTabId = next ? next.tabId : null;
      }
    }),
  );
}

export async function renderPage(
  docId: string,
  pageIndex: number,
  scale: number,
  rotation: number,
): Promise<ArrayBuffer> {
  const result = await invoke<ArrayBuffer | Uint8Array | number[]>(
    "pdf_render_page",
    { docId, pageIndex, scale, rotation },
  );
  if (result instanceof ArrayBuffer) return result;
  if (result instanceof Uint8Array) {
    return result.buffer.slice(
      result.byteOffset,
      result.byteOffset + result.byteLength,
    );
  }
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
  query: string,
): Promise<SearchHit[]> {
  return await invoke<SearchHit[]>("pdf_search", { docId, query });
}

export async function loadAnnotationSidecar(
  path: string,
): Promise<AnnotationSidecar | null> {
  return await invoke<AnnotationSidecar | null>("annotations_load", { path });
}

export async function saveAnnotationSidecar(
  path: string,
  data: AnnotationSidecar,
): Promise<void> {
  await invoke("annotations_save", { path, data });
}

export async function initialOpenPaths(): Promise<string[]> {
  return await invoke<string[]>("initial_open_paths");
}

export async function exportAnnotatedPdfFile(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;

  const target = await save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath: tab.path.replace(/\.pdf$/i, ".annotated.pdf"),
  });
  if (!target) return;

  const data: AnnotationSidecar = {
    version: 1,
    sourcePath: tab.path,
    updatedAt: new Date().toISOString(),
    annotations: tab.annotations.items,
  };
  try {
    await invoke("export_annotated_pdf", {
      sourcePath: tab.path,
      targetPath: target,
      data,
    });
    emitToast("주석을 포함한 PDF로 내보냈습니다", "info");
  } catch (error) {
    const message = errorMessage(error);
    console.error("export annotated pdf failed", error);
    emitToast(`내보내기 실패: ${message}`, "error");
  }
}

export interface PdfPageEditPayload {
  id: string;
  path: string;
  pageCount: number;
  pages: { index: number; width: number; height: number }[];
  fileSize: number;
  /** Mapping[oldIdx] = newIdx | null for annotation remap. */
  pageMapping: Array<number | null>;
}

export async function deletePdfPages(
  docId: string,
  indices: number[],
): Promise<PdfPageEditPayload> {
  return await invoke<PdfPageEditPayload>("pdf_delete_pages", {
    docId,
    indices,
  });
}

export async function copyPdfPages(
  docId: string,
  indices: number[],
): Promise<string> {
  return await invoke<string>("pdf_copy_pages", { docId, indices });
}

export async function pastePdfPages(
  docId: string,
  afterIndex: number,
  clipboardId: string,
): Promise<PdfPageEditPayload> {
  return await invoke<PdfPageEditPayload>("pdf_paste_pages", {
    docId,
    afterIndex,
    clipboardId,
  });
}

export async function duplicatePdfPages(
  docId: string,
  indices: number[],
): Promise<PdfPageEditPayload> {
  return await invoke<PdfPageEditPayload>("pdf_duplicate_pages", {
    docId,
    indices,
  });
}

export async function savePdfToPath(
  docId: string,
  targetPath: string,
): Promise<void> {
  await invoke("pdf_save_as", { docId, targetPath });
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrPagePayload {
  text: string;
  lines: OcrLine[];
}

export async function ocrPdfPage(
  docId: string,
  pageIndex: number,
): Promise<OcrPagePayload> {
  return await invoke<OcrPagePayload>("pdf_ocr_page", { docId, pageIndex });
}

export async function ocrPdfLines(
  docId: string,
  pageIndex: number,
): Promise<OcrLine[] | null> {
  return await invoke<OcrLine[] | null>("pdf_ocr_lines", {
    docId,
    pageIndex,
  });
}

export async function pdfNativeTextLines(
  docId: string,
  pageIndex: number,
): Promise<OcrLine[]> {
  return await invoke<OcrLine[]>("pdf_text_lines", { docId, pageIndex });
}

export async function ocrPdfStatus(docId: string): Promise<number[]> {
  return await invoke<number[]>("pdf_ocr_status", { docId });
}

/**
 * Save the active tab's modified PDF. If `asNew` is true, prompts for a target
 * path; otherwise overwrites the original file.
 */
export async function saveActivePdf(asNew = false): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return false;
  let target = tab.path;
  if (asNew) {
    const chosen = await save({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: tab.path,
    });
    if (!chosen) return false;
    target = chosen;
  }
  try {
    await savePdfToPath(tab.docId, target);
  } catch (error) {
    console.error("save pdf failed", error);
    window.alert(
      `저장 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  // After save: clear pageDirty flag, update path if changed
  setDocumentStore(
    produce((state) => {
      const idx = state.tabs.findIndex((t) => t.tabId === tab.tabId);
      if (idx < 0) return;
      state.tabs[idx].pageDirty = false;
      if (state.tabs[idx].path !== target) {
        state.tabs[idx].path = target;
      }
    }),
  );
  return true;
}
