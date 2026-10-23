import { snapshotPageEdit, commitPageEditHistory } from "./documentHistoryState";
import { emitToast } from "../capture/capture";
import { onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { produce } from "solid-js/store";
import {
  activeTab,
  documentStore,
  setDocumentStore,
  updateActiveTab,
  updateTabById,
  type PageMeta,
  type Tab,
} from "../state/document";
import {
  createAnnotationId,
  remapAnnotationsForTab,
} from "../annotations/store";
import {
  addDocumentTab,
  copyPdfPages,
  deletePdfPages,
  duplicatePdfPages,
  pastePdfPages,
} from "../ipc/pdf";
import { invoke, open } from "../platform/desktop";
import { undoDocumentEdit } from "./documentHistory";
import {
  moveToIndexFromSlot,
  reindexAnnotationsForPages,
  shouldHandlePageKey,
} from "./pageUi";
import { enqueueDocumentMutation } from "../ipc/documentMutations";
import { invalidateOcrForDocument } from "../ocr/ocr";
import type { Annotation } from "../annotations/types";

interface PageClipboardState {
  token: string | null;
  count: number;
  sourceTabPath: string | null;
  /** Editable annotations belonging to the copied pages. Their page indices
   * are local to the clipboard (0..count-1), not the source document. */
  annotations: Annotation[];
  /** When the page clipboard was last written, for paste arbitration against
   * the annotation clipboard. */
  copiedAt: number;
}

const [pageClipboard, setPageClipboard] = createStore<PageClipboardState>({
  token: null,
  count: 0,
  sourceTabPath: null,
  annotations: [],
  copiedAt: 0,
});

export { pageClipboard };

interface PdfPageEditPayload {
  id: string;
  revision: number;
  path: string;
  pageCount: number;
  pages: PageMeta[];
  fileSize: number;
  pageMapping: Array<number | null>;
  historyToken?: string;
  retainedHistoryTokens?: string[];
}

const READ_ONLY_MESSAGE = "읽기 전용 PDF입니다";

/** Page edits are refused on read-only tabs. */
export const guardWritable = (tab: Tab | null | undefined): tab is Tab => {
  if (!tab) return false;
  if (tab.readOnly) {
    emitToast(READ_ONLY_MESSAGE, "info");
    return false;
  }
  return true;
};

const isEditableTarget = (t: EventTarget | null): boolean => {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
};

const sortedSelection = (tab: Tab): number[] => {
  const out = [...tab.selectedPageIndices];
  out.sort((a, b) => a - b);
  return out;
};

const cloneAnnotations = (items: Annotation[]): Annotation[] =>
  JSON.parse(JSON.stringify(items)) as Annotation[];

/** Capture sidecar-backed annotations in the exact order in which the
 * backend copies the selected PDF pages. */
const snapshotAnnotationsForPages = (
  tab: Tab,
  pageIndices: number[],
): Annotation[] => {
  const clipboardPageBySource = new Map<number, number>();
  pageIndices.forEach((page, clipboardPage) => {
    clipboardPageBySource.set(page, clipboardPage);
  });
  return cloneAnnotations(tab.annotations.items)
    .filter((annotation) => clipboardPageBySource.has(annotation.page))
    .map((annotation) => ({
      ...annotation,
      page: clipboardPageBySource.get(annotation.page)!,
    }));
};

/** Materialize a clipboard annotation snapshot on newly inserted pages.
 * Fresh IDs keep the originals and pasted copies independently editable. */
const materializePageAnnotations = (
  snapshot: Annotation[],
  insertedStart: number,
): Annotation[] =>
  cloneAnnotations(snapshot).map((annotation) => ({
    ...annotation,
    id: createAnnotationId(),
    page: insertedStart + annotation.page,
  }));

const applyEditResult = (
  tabId: string,
  expectedDocId: string,
  expectedRevision: number,
  result: PdfPageEditPayload,
  newSelection: number[],
  newCurrentPage: number,
  insertedAnnotations: Annotation[] = [],
) => {
  const pages: PageMeta[] = result.pages.map((p) => ({
    index: p.index,
    width: p.width,
    height: p.height,
    rotation: p.rotation,
  }));
  const live = documentStore.tabs.find((tab) => tab.tabId === tabId);
  if (!live) return;
  if (
    live.docId !== expectedDocId ||
    live.revision !== expectedRevision ||
    result.id !== expectedDocId ||
    result.revision !== expectedRevision + 1
  ) {
    throw new Error(
      "문서가 편집 응답을 기다리는 동안 변경되어 결과를 적용하지 않았습니다.",
    );
  }
  const before = snapshotPageEdit(live);
  updateTabById(tabId, (t) => {
    t.docId = result.id;
    t.revision = result.revision;
    t.path = result.path;
    t.pageCount = result.pageCount;
    t.pages = pages;
    t.fileSize = result.fileSize;
    t.contentVersion += 1;
    t.pageDirty = true;
    t.selectedPageIndices = newSelection;
    t.pageAnchor = newSelection.length > 0 ? newSelection[0] : null;
    t.navigationVersion = (t.navigationVersion ?? 0) + 1;
    t.currentPage = Math.max(0, Math.min(result.pageCount - 1, newCurrentPage));
  });
  remapAnnotationsForTab(tabId, result.pageMapping, insertedAnnotations);
  commitPageEditHistory(tabId, before, result);
  invalidateOcrForDocument(result.id, result.revision, result.pageCount);
};

async function performCopySelectedPages(
  tabId: string,
  selectedIndices?: number[],
): Promise<boolean> {
  const tab = documentStore.tabs.find((candidate) => candidate.tabId === tabId);
  if (!tab) return false;
  const indices = selectedIndices ?? sortedSelection(tab);
  if (indices.length === 0) return false;
  const annotationSnapshot = snapshotAnnotationsForPages(tab, indices);
  try {
    const token = await copyPdfPages(tab.docId, tab.revision, indices);
    setPageClipboard({
      token,
      count: indices.length,
      sourceTabPath: tab.path,
      annotations: annotationSnapshot,
      copiedAt: Date.now(),
    });
    return true;
  } catch (error) {
    console.error("copy pages failed", error);
    emitToast(`페이지 복사 실패: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
}

export function copySelectedPages(): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return Promise.resolve(false);
  return enqueueDocumentMutation(tab.tabId, () =>
    performCopySelectedPages(tab.tabId),
  );
}

async function performDeleteSelectedPages(
  tabId: string,
  selectedIndices?: number[],
  announce = true,
): Promise<void> {
  const tab = documentStore.tabs.find((candidate) => candidate.tabId === tabId);
  if (!guardWritable(tab)) return;
  const indices = selectedIndices ?? sortedSelection(tab);
  if (indices.length === 0) return;
  if (indices.length >= tab.pageCount) {
    emitToast("모든 페이지를 삭제할 수는 없습니다.");
    return;
  }
  try {
    const expectedDocId = tab.docId;
    const expectedRevision = tab.revision;
    const result = await deletePdfPages(
      expectedDocId,
      expectedRevision,
      indices,
    );
    const firstDeleted = indices[0];
    const newCurrent = Math.min(firstDeleted, result.pageCount - 1);
    applyEditResult(
      tabId,
      expectedDocId,
      expectedRevision,
      result,
      [],
      newCurrent,
    );
    if (announce) {
      emitToast(`${indices.length}쪽을 삭제했습니다`, "info", {
        timeoutMs: 8000,
        actions: [{ label: "실행 취소", run: () => void undoDocumentEdit() }],
      });
    }
  } catch (error) {
    console.error("delete pages failed", error);
    emitToast(
      `페이지 삭제 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function deleteSelectedPages(): Promise<void> {
  const tab = activeTab();
  if (!tab) return Promise.resolve();
  return enqueueDocumentMutation(tab.tabId, () =>
    performDeleteSelectedPages(tab.tabId),
  );
}

async function performCutSelectedPages(tabId: string): Promise<void> {
  const tab = documentStore.tabs.find((candidate) => candidate.tabId === tabId);
  if (!guardWritable(tab)) return;
  if (tab.selectedPageIndices.length === 0) return;
  if (tab.selectedPageIndices.length >= tab.pageCount) {
    emitToast("모든 페이지를 잘라낼 수는 없습니다.");
    return;
  }
  const indices = sortedSelection(tab);
  // Only delete if the copy actually landed in the clipboard — otherwise a
  // failed copy followed by a successful delete silently destroys the pages.
  const copied = await performCopySelectedPages(tabId, indices);
  if (!copied) {
    emitToast("페이지 복사에 실패하여 잘라내기를 취소했습니다.");
    return;
  }
  await performDeleteSelectedPages(tabId, indices, false);
}

export function cutSelectedPages(): Promise<void> {
  const tab = activeTab();
  if (!tab) return Promise.resolve();
  return enqueueDocumentMutation(tab.tabId, () =>
    performCutSelectedPages(tab.tabId),
  );
}

/**
 * Paste from the page clipboard. `afterIndex = -1` pastes at the very start.
 * Defaults to "after the current selection's last page" or "after the current
 * page" if nothing is selected.
 */
export function pastePagesAfter(afterIndex?: number): Promise<void> {
  const tab = activeTab();
  if (!tab) return Promise.resolve();
  const tabId = tab.tabId;
  const token = pageClipboard.token;
  if (!token) {
    emitToast("클립보드에 페이지가 없습니다.");
    return Promise.resolve();
  }
  // Capture the annotation payload alongside the token before any await. A
  // later copy may replace the visible clipboard while this paste is queued.
  const annotationSnapshot = cloneAnnotations(pageClipboard.annotations);
  return enqueueDocumentMutation(tabId, async () => {
    const current = documentStore.tabs.find(
      (candidate) => candidate.tabId === tabId,
    );
    if (!guardWritable(current)) return;
    const after =
      afterIndex !== undefined
        ? afterIndex
        : current.selectedPageIndices.length > 0
          ? Math.max(...current.selectedPageIndices)
          : current.currentPage;
    try {
      const expectedDocId = current.docId;
      const expectedRevision = current.revision;
      const result = await pastePdfPages(
        expectedDocId,
        expectedRevision,
        after,
        token,
      );
      // The backend clamps an out-of-range afterIndex to the document bounds.
      // Mirror that exact insertion point for selection and annotation pages.
      const insertedStart = Math.max(0, Math.min(current.pageCount, after + 1));
      const actualInsertedCount = result.pageCount - current.pageCount;
      const newSelection: number[] = [];
      for (let i = 0; i < actualInsertedCount; i++) {
        newSelection.push(insertedStart + i);
      }
      applyEditResult(
        tabId,
        expectedDocId,
        expectedRevision,
        result,
        newSelection,
        insertedStart,
        materializePageAnnotations(annotationSnapshot, insertedStart),
      );
    } catch (error) {
      console.error("paste pages failed", error);
      emitToast(
        `페이지 붙여넣기 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export function duplicateSelectedPages(): Promise<void> {
  const tab = activeTab();
  if (!tab) return Promise.resolve();
  const tabId = tab.tabId;
  return enqueueDocumentMutation(tabId, async () => {
    const current = documentStore.tabs.find(
      (candidate) => candidate.tabId === tabId,
    );
    if (!guardWritable(current)) return;
    const indices = sortedSelection(current);
    if (indices.length === 0) return;
    const annotationSnapshot = snapshotAnnotationsForPages(current, indices);
    try {
      const expectedDocId = current.docId;
      const expectedRevision = current.revision;
      const result = await duplicatePdfPages(
        expectedDocId,
        expectedRevision,
        indices,
      );
      const insertedStart = indices[indices.length - 1] + 1;
      const newSelection: number[] = [];
      for (let i = 0; i < indices.length; i++) {
        newSelection.push(insertedStart + i);
      }
      applyEditResult(
        tabId,
        expectedDocId,
        expectedRevision,
        result,
        newSelection,
        insertedStart,
        materializePageAnnotations(annotationSnapshot, insertedStart),
      );
    } catch (error) {
      console.error("duplicate pages failed", error);
      emitToast(
        `페이지 복제 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

// Thumbnail multi-selection helpers

export const togglePageSelection = (index: number) => {
  updateActiveTab((tab) => {
    const set = new Set(tab.selectedPageIndices);
    if (set.has(index)) set.delete(index);
    else set.add(index);
    tab.selectedPageIndices = [...set].sort((a, b) => a - b);
    tab.pageAnchor = index;
    tab.navigationVersion = (tab.navigationVersion ?? 0) + 1;
    tab.currentPage = index;
  });
};

export const setSinglePageSelection = (index: number) => {
  updateActiveTab((tab) => {
    tab.selectedPageIndices = [index];
    tab.pageAnchor = index;
    tab.navigationVersion = (tab.navigationVersion ?? 0) + 1;
    tab.currentPage = index;
  });
};

export const extendPageSelection = (index: number) => {
  updateActiveTab((tab) => {
    const anchor = tab.pageAnchor ?? tab.currentPage;
    const lo = Math.min(anchor, index);
    const hi = Math.max(anchor, index);
    const range: number[] = [];
    for (let i = lo; i <= hi; i++) range.push(i);
    tab.selectedPageIndices = range;
    tab.navigationVersion = (tab.navigationVersion ?? 0) + 1;
    tab.currentPage = index;
  });
};

export const clearPageSelection = () => {
  setDocumentStore(
    "tabs",
    documentStore.tabs.findIndex((t) => t.tabId === documentStore.activeTabId),
    produce((tab: Tab) => {
      tab.selectedPageIndices = [];
      tab.pageAnchor = null;
    }),
  );
};

/** Move the selected pages so they land at `slot` (0..pageCount, "before page
 * slot" in the current order). */
export function moveSelectedPages(slot: number): Promise<void> {
  const tab = activeTab();
  if (!tab) return Promise.resolve();
  const tabId = tab.tabId;
  return enqueueDocumentMutation(tabId, async () => {
    const current = documentStore.tabs.find((t) => t.tabId === tabId);
    if (!guardWritable(current)) return;
    const indices = sortedSelection(current);
    const toIndex = moveToIndexFromSlot(indices, slot, current.pageCount);
    if (toIndex === null) return;
    try {
      const expectedDocId = current.docId;
      const expectedRevision = current.revision;
      const result = await invoke<PdfPageEditPayload>("pdf_move_pages", {
        docId: expectedDocId,
        expectedRevision,
        indices,
        toIndex,
      });
      const moved = indices
        .map((i) => result.pageMapping[i])
        .filter((i): i is number => i != null)
        .sort((a, b) => a - b);
      applyEditResult(
        tabId,
        expectedDocId,
        expectedRevision,
        result,
        moved,
        moved[0] ?? toIndex,
      );
    } catch (error) {
      console.error("move pages failed", error);
      emitToast(
        `페이지 이동 실패: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });
}

/** Extract the selected pages into a new unsaved tab, copying annotations. */
export function extractSelectedPages(): Promise<void> {
  const tab = activeTab();
  if (!tab) return Promise.resolve();
  const tabId = tab.tabId;
  return enqueueDocumentMutation(tabId, async () => {
    const current = documentStore.tabs.find((t) => t.tabId === tabId);
    if (!current) return;
    const indices = sortedSelection(current);
    if (indices.length === 0) return;
    const annotations = reindexAnnotationsForPages(
      cloneAnnotations(current.annotations.items),
      indices,
    ).map((a) => ({ ...a, id: createAnnotationId() }));
    const base = current.path.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "") || "문서";
    try {
      const payload = await invoke<Parameters<typeof addDocumentTab>[0]>(
        "pdf_extract_pages",
        {
          docId: current.docId,
          expectedRevision: current.revision,
          indices,
          name: `${base} 추출`,
        },
      );
      addDocumentTab(payload, { annotations, unsaved: true });
    } catch (error) {
      console.error("extract pages failed", error);
      emitToast(
        `페이지 추출 실패: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });
}

/** Choose a PDF and insert all of its pages after `afterIndex`. */
export async function insertPdfAfter(afterIndex?: number): Promise<void> {
  const tab = activeTab();
  if (!guardWritable(tab)) return;
  const tabId = tab.tabId;
  let selected: string | string[] | null;
  try {
    selected = await open({
      multiple: false,
      title: "삽입할 PDF 선택",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  } catch (error) {
    emitToast(
      `파일 선택 창을 열 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return;
  return enqueueDocumentMutation(tabId, async () => {
    const current = documentStore.tabs.find((t) => t.tabId === tabId);
    if (!guardWritable(current)) return;
    const after =
      afterIndex ??
      (current.selectedPageIndices.length > 0
        ? Math.max(...current.selectedPageIndices)
        : current.currentPage);
    try {
      const expectedDocId = current.docId;
      const expectedRevision = current.revision;
      const result = await invoke<PdfPageEditPayload>("pdf_insert_file", {
        docId: expectedDocId,
        expectedRevision,
        path,
        afterIndex: after,
      });
      const insertedStart = Math.max(0, Math.min(current.pageCount, after + 1));
      const count = result.pageCount - current.pageCount;
      const selection = Array.from({ length: count }, (_, i) => insertedStart + i);
      applyEditResult(tabId, expectedDocId, expectedRevision, result, selection, insertedStart);
    } catch (error) {
      console.error("insert pdf failed", error);
      emitToast(
        `PDF 삽입 실패: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });
}

export function installPageClipboardShortcuts() {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const hasTextSelection = (window.getSelection()?.toString() ?? "") !== "";
      if (
        !shouldHandlePageKey({
          insideThumbnailSidebar: !!active?.closest?.(".thumbnail-sidebar"),
          editableTarget: isEditableTarget(e.target),
          hasTextSelection,
          mod: e.metaKey || e.ctrlKey,
          key: e.key,
        })
      )
        return;
      const tab = activeTab();
      if (!tab) return;
      const hasSelection = tab.selectedPageIndices.length > 0;
      const key = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) {
        if (key === "v") {
          if (!pageClipboard.token) return;
          e.preventDefault();
          void pastePagesAfter();
          return;
        }
        if (!hasSelection) return;
        e.preventDefault();
        if (key === "c") void copySelectedPages();
        else if (key === "x") void cutSelectedPages();
        else void duplicateSelectedPages();
        return;
      }
      if (!hasSelection) return;
      e.preventDefault();
      void deleteSelectedPages();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
}
