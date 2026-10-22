import { ensureAnnotationFonts } from "../annotations/fonts";
import { invoke } from "../platform/desktop";
import { open, save, confirmUnsaved } from "../platform/desktop";
import { normalizeImageSource } from "../images/normalize";
import { emitToast } from "../capture/capture";
import {
  markAnnotationSaveErrorForTab,
  setAnnotationSaveStatusForTab,
} from "../annotations/store";
import { measureTextLayout } from "../annotations/textLayout";
import { sanitizeAnnotation } from "../annotations/sanitize";
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
  updateTabById,
  type PageMeta,
  type Tab,
} from "../state/document";
import { produce } from "solid-js/store";
import { enqueueDocumentMutation } from "./documentMutations";

const makeSidecar = (
  tab: Tab,
  sourcePath: string,
  annotations: Annotation[],
  documentRevision = tab.revision,
  documentKey = tab.annotationDocumentKey,
  /**
   * Attach each text annotation's measured line layout. Only for the export
   * payload — the measurement describes the current DOM, so persisting it in
   * the sidecar would leave a stale copy behind the next edit.
   */
  measureText = false,
): AnnotationSidecar => {
  // Deep-copy/unwrap Solid.js Store proxies before crossing the desktop bridge
  const cleanAnnotations: Annotation[] = JSON.parse(
    JSON.stringify(annotations),
  ).map(sanitizeAnnotation);
  if (measureText) {
    for (const annotation of cleanAnnotations) {
      if (annotation.type !== "text") continue;
      const layout = measureTextLayout(annotation);
      if (!layout || layout.length === 0) continue;
      annotation.payload = { ...(annotation.payload ?? {}), layout };
    }
  }
  return {
    version: 2,
    documentKey,
    sourcePath,
    documentRevision,
    pageLayout: tab.pages.map(({ width, height, rotation }) => ({
      width,
      height,
      rotation,
    })),
    updatedAt: new Date().toISOString(),
    annotations: cleanAnnotations,
  };
};

interface OpenedDocPayload {
  id: string;
  revision: number;
  path: string;
  pageCount: number;
  pages: PageMeta[];
  fileSize: number;
}

export type DirtyChoice = "save" | "discard" | "cancel";

export interface AnnotationLoadResult {
  sidecar: AnnotationSidecar | null;
  status: "none" | "exact" | "legacy" | "recovered" | "mismatch" | "ambiguous";
  message: string | null;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function flushAnnotationSaveForTab(tabId: string): Promise<void> {
  await enqueueDocumentMutation(tabId, async () => {
    const idx = findTabIndex(tabId);
    if (idx < 0) return;
    const tab = documentStore.tabs[idx];
    if (!tab.annotations.dirty) return;
    if (tab.pageDirty) {
      const saved = await performSaveTabPdf(tabId, false);
      if (!saved) throw new Error("PDF 저장이 취소되거나 실패했습니다.");
      return;
    }
    setAnnotationSaveStatusForTab(tabId, "saving");
    const snapshotVersion = tab.annotations.editVersion;
    const snapshot = makeSidecar(tab, tab.path, tab.annotations.items);
    await saveAnnotationSidecar(tab.docId, tab.revision, tab.path, snapshot);
    updateTabById(tabId, (current) => {
      if (current.annotations.editVersion === snapshotVersion) {
        current.annotations.dirty = false;
        current.annotations.saveStatus = "saved";
        current.annotations.lastSavedAt = new Date().toISOString();
      } else {
        current.annotations.saveStatus = "idle";
      }
      current.annotations.saveError = null;
    });
  });
}

export async function flushActiveAnnotationSave(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  await flushAnnotationSaveForTab(tab.tabId);
}

export async function promptUnsavedChanges(
  message = "저장하지 않은 변경사항이 있습니다. 저장하시겠습니까?",
): Promise<DirtyChoice> {
  const tab = activeTab();
  if (!tab || (!tab.annotations.dirty && !tab.pageDirty)) {
    return "discard";
  }
  return confirmUnsaved(message);
}

export async function guardActiveTabUnsaved(): Promise<boolean> {
  const choice = await promptUnsavedChanges();
  if (choice === "cancel") return false;
  if (choice === "save") {
    try {
      const saved = await saveActivePdf();
      if (!saved) {
        return window.confirm("저장에 실패했습니다. 그래도 계속하시겠습니까?");
      }
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
  revision: payload.revision,
  annotationDocumentKey: generateTabId(),
  path: payload.path,
  pageCount: payload.pageCount,
  pages: payload.pages,
  fileSize: payload.fileSize,
  contentVersion: 0,
  zoom: 1,
  rotation: 0,
  currentPage: 0,
  navigationVersion: 0,
  selectedPageIndices: [],
  pageAnchor: null,
  pageDirty: false,
  annotations: emptyAnnotationTabState(),
});

export async function openImagesAsPdf(
  paths: string[],
  name: string,
): Promise<void> {
  const payload = await invoke<OpenedDocPayload>("pdf_create_from_images", {
    paths,
    name,
  });
  const tab = buildTabFromPayload(payload);
  tab.isUnsaved = true;
  tab.pageDirty = true;
  setDocumentStore(
    produce((state) => {
      state.tabs.push(tab);
      state.activeTabId = tab.tabId;
    }),
  );
}

async function performOpenPdf(path: string): Promise<void> {
  const existing = documentStore.tabs.find((t) => t.path === path);
  if (existing) {
    setActiveTab(existing.tabId);
    return;
  }

  setDocumentStore({ loading: true, error: null });
  try {
    const payload = await invoke<OpenedDocPayload>("pdf_open", { path });
    const tab = buildTabFromPayload(payload);
    let loaded: AnnotationLoadResult = {
      sidecar: null,
      status: "none",
      message: null,
    };
    try {
      loaded = await loadAnnotationSidecar(
        payload.id,
        payload.revision,
        payload.path,
      );
      // Finish sidecar loading before publishing the tab. Otherwise a user
      // can create an annotation while this IPC is in flight and have the
      // late load response silently replace that new work.
      const items = loaded.sidecar?.annotations ?? [];
      if (!Array.isArray(items))
        throw new Error("주석 목록 형식이 올바르지 않습니다.");
      tab.annotations.items = JSON.parse(JSON.stringify(items)).map(
        sanitizeAnnotation,
      );
      if (loaded.sidecar?.documentKey) {
        tab.annotationDocumentKey = loaded.sidecar.documentKey;
      }
    } catch (error) {
      console.error("load annotation sidecar failed", error);
      emitToast(`주석 불러오기 실패: ${errorMessage(error)}`, "error", {
        timeoutMs: 9000,
      });
    }
    setDocumentStore(
      produce((state) => {
        state.tabs.push(tab);
        state.activeTabId = tab.tabId;
        state.loading = false;
      }),
    );
    if (loaded.message) {
      emitToast(
        loaded.message,
        loaded.status === "mismatch" || loaded.status === "ambiguous"
          ? "error"
          : "info",
        { timeoutMs: loaded.status === "recovered" ? 6000 : 9000 },
      );
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

// File-drop, OS-open, and dialog events can arrive together. Serializing the
// open flow prevents two calls from both passing the "already open" check and
// registering duplicate backend handles for the same path.
let openTail: Promise<void> = Promise.resolve();

/**
 * Open a PDF as a new tab. If the same file is already open, just activate
 * that tab (Acrobat-like behaviour).
 */
export function openPdf(path: string): Promise<void> {
  const operation = openTail.then(() => performOpenPdf(path));
  openTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
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

async function performCloseTab(tabId: string): Promise<void> {
  const idx = findTabIndex(tabId);
  if (idx < 0) return;
  const tab = documentStore.tabs[idx];

  if (tab.annotations.dirty || tab.pageDirty) {
    const choice = await confirmUnsaved(
      `${fileNameFromPath(tab.path)}에 저장되지 않은 변경사항이 있습니다. 저장하시겠습니까?`,
    );
    if (choice === "cancel") return;
    if (choice === "save") {
      const saved = await performSaveTabUntilClean(tab.tabId);
      if (!saved) {
        const force = window.confirm(
          "저장에 실패했습니다. 그래도 닫으시겠습니까?",
        );
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

export function closeTab(tabId: string): Promise<void> {
  return enqueueDocumentMutation(tabId, () => performCloseTab(tabId));
}

export async function renderPage(
  docId: string,
  expectedRevision: number,
  pageIndex: number,
  scale: number,
  rotation: number,
): Promise<ArrayBuffer> {
  const result = await invoke<ArrayBuffer | Uint8Array | number[]>(
    "pdf_render_page",
    { docId, expectedRevision, pageIndex, scale, rotation },
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
  space?: "raw" | "display";
  rectangles?: Array<{ x: number; y: number; w: number; h: number; space?: "raw" | "display" }>;
}

export async function searchPdf(
  docId: string,
  expectedRevision: number,
  query: string,
): Promise<SearchHit[]> {
  return await invoke<SearchHit[]>("pdf_search", {
    docId,
    expectedRevision,
    query,
  });
}

export async function loadAnnotationSidecar(
  docId: string,
  expectedRevision: number,
  path: string,
): Promise<AnnotationLoadResult> {
  return await invoke<AnnotationLoadResult>("annotations_load", {
    docId,
    expectedRevision,
    path,
  });
}

export async function saveAnnotationSidecar(
  docId: string,
  expectedRevision: number,
  path: string,
  data: AnnotationSidecar,
): Promise<void> {
  await invoke("annotations_save", {
    docId,
    expectedRevision,
    path,
    data,
  });
}

export async function initialOpenPaths(): Promise<string[]> {
  return await invoke<string[]>("initial_open_paths");
}

export async function exportAnnotatedPdfFile(): Promise<void> {
  const selectedTab = activeTab();
  if (!selectedTab) return;
  const tabId = selectedTab.tabId;

  const target = await save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath: selectedTab.isUnsaved
      ? fileNameFromPath(selectedTab.path)
      : selectedTab.path.replace(/\.pdf$/i, ".annotated.pdf"),
  });
  if (!target) return;
  const conflictingTab = documentStore.tabs.find(
    (candidate) => candidate.path === target,
  );
  if (conflictingTab) {
    emitToast("열려 있는 PDF에는 내보낼 수 없습니다. 원본과 다른 경로를 선택해 주세요.", "error");
    return;
  }

  try {
    await enqueueDocumentMutation(tabId, async () => {
      const tab = documentStore.tabs.find(
        (candidate) => candidate.tabId === tabId,
      );
      if (!tab) return;
      await ensureAnnotationFonts();
      const data = makeSidecar(
        tab,
        tab.path,
        tab.annotations.items,
        tab.revision,
        tab.annotationDocumentKey,
        true,
      );
      for (const annotation of data.annotations) {
        if (annotation.type === "image" && annotation.payload?.imageSrc) {
          annotation.payload.imageSrc = await normalizeImageSource(
            annotation.payload.imageSrc,
          );
        }
      }
      await invoke("export_annotated_pdf", {
        docId: tab.docId,
        expectedRevision: tab.revision,
        targetPath: target,
        data,
      });
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
  revision: number;
  path: string;
  pageCount: number;
  pages: PageMeta[];
  fileSize: number;
  /** Mapping[oldIdx] = newIdx | null for annotation remap. */
  pageMapping: Array<number | null>;
}

export async function deletePdfPages(
  docId: string,
  expectedRevision: number,
  indices: number[],
): Promise<PdfPageEditPayload> {
  return await invoke<PdfPageEditPayload>("pdf_delete_pages", {
    docId,
    expectedRevision,
    indices,
  });
}

export async function copyPdfPages(
  docId: string,
  expectedRevision: number,
  indices: number[],
): Promise<string> {
  return await invoke<string>("pdf_copy_pages", {
    docId,
    expectedRevision,
    indices,
  });
}

export async function pastePdfPages(
  docId: string,
  expectedRevision: number,
  afterIndex: number,
  clipboardId: string,
): Promise<PdfPageEditPayload> {
  return await invoke<PdfPageEditPayload>("pdf_paste_pages", {
    docId,
    expectedRevision,
    afterIndex,
    clipboardId,
  });
}

export async function duplicatePdfPages(
  docId: string,
  expectedRevision: number,
  indices: number[],
): Promise<PdfPageEditPayload> {
  return await invoke<PdfPageEditPayload>("pdf_duplicate_pages", {
    docId,
    expectedRevision,
    indices,
  });
}

export async function rotatePdfPages(
  docId: string,
  expectedRevision: number,
  indices: number[],
  direction: 1 | -1,
): Promise<PdfPageEditPayload> {
  return await invoke<PdfPageEditPayload>("pdf_rotate_pages", {
    docId,
    expectedRevision,
    indices,
    direction,
  });
}

export async function savePdfDocument(
  docId: string,
  expectedRevision: number,
  targetPath: string,
  data?: AnnotationSidecar | null,
  sidecar?: AnnotationSidecar | null,
): Promise<OpenedDocPayload> {
  return await invoke<OpenedDocPayload>("pdf_save_document", {
    docId,
    expectedRevision,
    targetPath,
    data: data ?? null,
    sidecar: sidecar ?? null,
  });
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
  expectedRevision: number,
  pageIndex: number,
): Promise<OcrPagePayload> {
  return await invoke<OcrPagePayload>("pdf_ocr_page", {
    docId,
    expectedRevision,
    pageIndex,
  });
}

export async function ocrPdfLines(
  docId: string,
  expectedRevision: number,
  pageIndex: number,
): Promise<OcrLine[] | null> {
  return await invoke<OcrLine[] | null>("pdf_ocr_lines", {
    docId,
    expectedRevision,
    pageIndex,
  });
}

export async function pdfNativeTextLines(
  docId: string,
  expectedRevision: number,
  pageIndex: number,
): Promise<OcrLine[]> {
  return await invoke<OcrLine[]>("pdf_text_lines", {
    docId,
    expectedRevision,
    pageIndex,
  });
}

export async function ocrPdfStatus(
  docId: string,
  expectedRevision: number,
): Promise<number[]> {
  return await invoke<number[]>("pdf_ocr_status", {
    docId,
    expectedRevision,
  });
}

async function performSaveTabPdf(
  tabId: string,
  asNew = false,
): Promise<boolean> {
  const idx = findTabIndex(tabId);
  if (idx < 0) return false;

  const currentTab = documentStore.tabs[idx];
  let target = currentTab.path;
  if (asNew || currentTab.isUnsaved) {
    const chosen = await save({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: currentTab.isUnsaved
        ? fileNameFromPath(currentTab.path)
        : currentTab.path,
    });
    if (!chosen) return false;
    const conflictingTab = documentStore.tabs.find(
      (candidate) => candidate.tabId !== tabId && candidate.path === chosen,
    );
    if (conflictingTab) {
      emitToast("선택한 파일은 다른 탭에서 열려 있습니다. 다른 경로를 선택해 주세요.", "error");
      return false;
    }
    target = chosen;
  }

  try {
    // The save dialog yields to the UI. Another tab can close while it is
    // open and shift every array index, so reacquire by stable tab identity.
    const liveIdx = findTabIndex(tabId);
    if (liveIdx < 0) return false;
    const tab = documentStore.tabs[liveIdx];
    if (!tab) return false;
    const savedAt = new Date().toISOString();
    const pathChanged = target !== tab.path;
    const bytesChanged = tab.pageDirty || pathChanged;
    // Save As creates a distinct metadata identity. Otherwise two identical
    // PDF copies would overwrite the same fingerprint/document-key record.
    const targetDocumentKey = pathChanged
      ? generateTabId()
      : tab.annotationDocumentKey;

    if (tab.annotations.dirty) {
      setAnnotationSaveStatusForTab(tab.tabId, "saving");
    }

    // Capture the editable objects and their layout before the IPC. The
    // backend stages this fingerprint-addressed sidecar before atomically
    // replacing the PDF, closing the cross-file crash window.
    const savedVersion = tab.annotations.editVersion;
    const sidecar = makeSidecar(
      tab,
      target,
      tab.annotations.items,
      tab.revision + 1,
      targetDocumentKey,
    );

    // Save the PDF bytes only — annotations stay in the sidecar so the user
    // can keep moving/removing them. Flattening into the PDF only happens at
    // export time.
    const saved = await savePdfDocument(
      tab.docId,
      tab.revision,
      target,
      null,
      sidecar,
    );

    setDocumentStore(
      produce((state) => {
        const saveIdx = state.tabs.findIndex((t) => t.tabId === tabId);
        if (saveIdx < 0) return;
        const target = state.tabs[saveIdx];
        // Only swap the `pages` array if the page layout actually changed —
        // otherwise the new objects break Solid's <For> identity and force
        // every PageCanvas to remount, which shows up as a viewer flash.
        const layoutChanged =
          target.pages.length !== saved.pages.length ||
          target.pages.some(
            (p, i) =>
              p.width !== saved.pages[i].width ||
              p.height !== saved.pages[i].height ||
              p.rotation !== saved.pages[i].rotation,
          );
        target.docId = saved.id;
        target.revision = saved.revision;
        target.annotationDocumentKey = targetDocumentKey;
        target.path = saved.path;
        target.isUnsaved = false;
        target.pageCount = saved.pageCount;
        if (layoutChanged) target.pages = saved.pages;
        target.fileSize = saved.fileSize;
        // Only bump contentVersion when bytes actually changed; bumping on
        // every save would refire the per-page render effect and produce a
        // brief flash, even though the bitmap content is unchanged.
        if (bytesChanged) target.contentVersion += 1;
        target.pageDirty = false;
        target.annotations.saveError = null;
        target.annotations.lastSavedAt = savedAt;
        if (target.annotations.editVersion === savedVersion) {
          target.annotations.dirty = false;
          target.annotations.saveStatus = "saved";
        } else {
          // Edits arrived during the save round-trip and weren't persisted —
          // keep dirty so autosave reflushes them.
          target.annotations.saveStatus = "idle";
        }
      }),
    );
  } catch (error) {
    console.error("save pdf failed", error);
    const message = error instanceof Error ? error.message : String(error);
    const failedTab = documentStore.tabs.find((tab) => tab.tabId === tabId);
    if (failedTab?.annotations.dirty) {
      markAnnotationSaveErrorForTab(tabId, message);
    }
    emitToast(`저장 실패: ${message}. 저장 경로와 권한을 확인한 후 다시 시도해 주세요.`, "error");
    return false;
  }
  return true;
}

export function saveTabPdf(tabId: string, asNew = false): Promise<boolean> {
  return enqueueDocumentMutation(tabId, () => performSaveTabPdf(tabId, asNew));
}

/**
 * Save the active tab's modified PDF. If `asNew` is true, prompts for a target
 * path; otherwise overwrites the original file.
 */
export async function saveActivePdf(asNew = false): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return false;
  return await saveTabPdf(tab.tabId, asNew);
}

async function performSaveTabUntilClean(
  tabId: string,
  maxAttempts = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = documentStore.tabs.find((tab) => tab.tabId === tabId);
    if (!current) return false;
    if (!current.pageDirty && !current.annotations.dirty) return true;
    if (!(await performSaveTabPdf(tabId, false))) return false;
  }
  const current = documentStore.tabs.find((tab) => tab.tabId === tabId);
  return Boolean(current && !current.pageDirty && !current.annotations.dirty);
}

/** Save a tab and reflush edits that arrived during the previous round-trip. */
export function saveTabPdfUntilClean(tabId: string): Promise<boolean> {
  return enqueueDocumentMutation(tabId, () => performSaveTabUntilClean(tabId));
}
