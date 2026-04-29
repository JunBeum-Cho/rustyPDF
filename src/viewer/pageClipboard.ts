import { onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { produce } from "solid-js/store";
import {
  activeTab,
  documentStore,
  setDocumentStore,
  updateActiveTab,
  type PageMeta,
  type Tab,
} from "../state/document";
import { annotationStore, remapAnnotationsForTab } from "../annotations/store";
import {
  copyPdfPages,
  deletePdfPages,
  duplicatePdfPages,
  pastePdfPages,
} from "../ipc/pdf";

interface PageClipboardState {
  token: string | null;
  count: number;
  sourceTabPath: string | null;
}

const [pageClipboard, setPageClipboard] = createStore<PageClipboardState>({
  token: null,
  count: 0,
  sourceTabPath: null,
});

export { pageClipboard };

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

const applyEditResult = (
  tab: Tab,
  result: {
    id: string;
    path: string;
    pageCount: number;
    pages: { index: number; width: number; height: number }[];
    fileSize: number;
    pageMapping: Array<number | null>;
  },
  newSelection: number[],
  newCurrentPage: number,
) => {
  const pages: PageMeta[] = result.pages.map((p) => ({
    index: p.index,
    width: p.width,
    height: p.height,
  }));
  updateActiveTab((t) => {
    t.docId = result.id;
    t.path = result.path;
    t.pageCount = result.pageCount;
    t.pages = pages;
    t.fileSize = result.fileSize;
    t.pageDirty = true;
    t.selectedPageIndices = newSelection;
    t.pageAnchor = newSelection.length > 0 ? newSelection[0] : null;
    t.currentPage = Math.max(
      0,
      Math.min(result.pageCount - 1, newCurrentPage),
    );
  });
  remapAnnotationsForTab(tab.tabId, result.pageMapping);
};

export async function copySelectedPages(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  const indices = sortedSelection(tab);
  if (indices.length === 0) return;
  try {
    const token = await copyPdfPages(tab.docId, indices);
    setPageClipboard({
      token,
      count: indices.length,
      sourceTabPath: tab.path,
    });
  } catch (error) {
    console.error("copy pages failed", error);
  }
}

export async function deleteSelectedPages(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  const indices = sortedSelection(tab);
  if (indices.length === 0) return;
  if (indices.length >= tab.pageCount) {
    window.alert("모든 페이지를 삭제할 수는 없습니다.");
    return;
  }
  try {
    const result = await deletePdfPages(tab.docId, indices);
    const firstDeleted = indices[0];
    const newCurrent = Math.min(firstDeleted, result.pageCount - 1);
    applyEditResult(tab, result, [], newCurrent);
  } catch (error) {
    console.error("delete pages failed", error);
    window.alert(
      `페이지 삭제 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function cutSelectedPages(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  if (tab.selectedPageIndices.length === 0) return;
  if (tab.selectedPageIndices.length >= tab.pageCount) {
    window.alert("모든 페이지를 잘라낼 수는 없습니다.");
    return;
  }
  await copySelectedPages();
  await deleteSelectedPages();
}

/**
 * Paste from the page clipboard. `afterIndex = -1` pastes at the very start.
 * Defaults to "after the current selection's last page" or "after the current
 * page" if nothing is selected.
 */
export async function pastePagesAfter(afterIndex?: number): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  const token = pageClipboard.token;
  if (!token) {
    window.alert("클립보드에 페이지가 없습니다.");
    return;
  }
  const after =
    afterIndex !== undefined
      ? afterIndex
      : tab.selectedPageIndices.length > 0
        ? Math.max(...tab.selectedPageIndices)
        : tab.currentPage;
  try {
    const result = await pastePdfPages(tab.docId, after, token);
    const insertedStart = after + 1;
    const insertedCount = pageClipboard.count;
    const newSelection: number[] = [];
    for (let i = 0; i < insertedCount; i++) newSelection.push(insertedStart + i);
    applyEditResult(tab, result, newSelection, insertedStart);
  } catch (error) {
    console.error("paste pages failed", error);
    window.alert(
      `페이지 붙여넣기 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function duplicateSelectedPages(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  const indices = sortedSelection(tab);
  if (indices.length === 0) return;
  try {
    const result = await duplicatePdfPages(tab.docId, indices);
    const insertedStart = indices[indices.length - 1] + 1;
    const newSelection: number[] = [];
    for (let i = 0; i < indices.length; i++) {
      newSelection.push(insertedStart + i);
    }
    applyEditResult(tab, result, newSelection, insertedStart);
  } catch (error) {
    console.error("duplicate pages failed", error);
    window.alert(
      `페이지 복제 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Thumbnail multi-selection helpers

export const togglePageSelection = (index: number) => {
  updateActiveTab((tab) => {
    const set = new Set(tab.selectedPageIndices);
    if (set.has(index)) set.delete(index);
    else set.add(index);
    tab.selectedPageIndices = [...set].sort((a, b) => a - b);
    tab.pageAnchor = index;
    tab.currentPage = index;
  });
};

export const setSinglePageSelection = (index: number) => {
  updateActiveTab((tab) => {
    tab.selectedPageIndices = [index];
    tab.pageAnchor = index;
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
    tab.currentPage = index;
  });
};

export const clearPageSelection = () => {
  setDocumentStore(
    "tabs",
    documentStore.tabs.findIndex(
      (t) => t.tabId === documentStore.activeTabId,
    ),
    produce((tab: Tab) => {
      tab.selectedPageIndices = [];
      tab.pageAnchor = null;
    }),
  );
};

export function installPageClipboardShortcuts() {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const tab = activeTab();
      if (!tab) return;
      const mod = e.metaKey || e.ctrlKey;

      // Page-level shortcuts only fire when the user has thumbnails selected,
      // so they don't conflict with annotation undo/copy/etc.
      const hasSelection = tab.selectedPageIndices.length > 0;

      if (mod && (e.key === "c" || e.key === "C")) {
        if (!hasSelection) return;
        e.preventDefault();
        void copySelectedPages();
        return;
      }
      if (mod && (e.key === "x" || e.key === "X")) {
        if (!hasSelection) return;
        e.preventDefault();
        void cutSelectedPages();
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        if (!pageClipboard.token) return;
        e.preventDefault();
        void pastePagesAfter();
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        if (!hasSelection) return;
        e.preventDefault();
        void duplicateSelectedPages();
        return;
      }
      if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
        if (!hasSelection) return;
        // Annotations and pages share Delete. When both have a selection the
        // user is almost always operating on the annotation they just clicked
        // (page selection is sticky from earlier thumbnail navigation), so
        // yield to the annotation handler in keyboard.ts. Page-delete still
        // works fine when no annotation is selected.
        if (annotationStore.selectedIds.length > 0) return;
        e.preventDefault();
        void deleteSelectedPages();
        return;
      }
    };
    // Capture phase so we run before the annotation keyboard handler in keyboard.ts.
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
}
