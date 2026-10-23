import { activeTab, documentStore, updateTabById, type DocumentHistoryEntry, type PageMeta } from "../state/document";
import { invalidateOcrForDocument } from "../ocr/ocr";
import { invoke } from "../platform/desktop";
import { enqueueDocumentMutation } from "../ipc/documentMutations";
import { emitToast } from "../capture/capture";
import {
  snapshotPageEdit, cloneHistoryValue, retainDocumentHistory, pushHistoryEntry, withHistoryBusy, historyBusy,
} from "./documentHistoryState";

export { historyBusy };
export const canUndoDocumentEdit = (): boolean => (activeTab()?.editHistory?.length ?? 0) > 0;
export const canRedoDocumentEdit = (): boolean => (activeTab()?.editFuture?.length ?? 0) > 0;

type RestoreResult = { id: string; revision: number; pages: PageMeta[]; pageCount: number; fileSize: number; retainedHistoryTokens: string[] };

function applyAnnotationItems(tab: { annotations: import("../state/document").AnnotationTabState }, items: import("../annotations/types").Annotation[]) {
  const state = tab.annotations;
  state.items = cloneHistoryValue(items);
  state.selectedIds = [];
  state.editingId = null;
  state.editVersion += 1;
  state.dirty = true;
  state.saveStatus = "idle";
  state.saveError = null;
}

async function restore(tabId: string, redo: boolean) {
  const tab = documentStore.tabs.find(t => t.tabId === tabId);
  if (!tab) return;
  const entry = (redo ? tab.editFuture : tab.editHistory)?.at(-1);
  if (!entry) return;
  if (entry.kind === "annotation") {
    updateTabById(tabId, current => {
      const source = redo ? current.editFuture! : current.editHistory!;
      const destination = redo ? (current.editHistory ??= []) : (current.editFuture ??= []);
      source.pop();
      pushHistoryEntry(destination, { kind: "annotation", items: cloneHistoryValue(current.annotations.items) });
      applyAnnotationItems(current, entry.items);
    });
    return;
  }
  await withHistoryBusy(async () => {
    const revision = tab.revision;
    const result = await invoke<RestoreResult>("pdf_restore_snapshot", {
      docId: tab.docId, expectedRevision: revision, token: entry.token,
    });
    const live = documentStore.tabs.find(t => t.tabId === tabId);
    if (!live) return;
    if (live.docId !== result.id || live.revision !== revision)
      throw new Error("문서가 변경되어 실행 취소 결과를 적용하지 않았습니다.");
    const opposite = snapshotPageEdit(live);
    const saved = cloneHistoryValue((entry as Extract<DocumentHistoryEntry, { kind: "page" }>).snapshot);
    updateTabById(tabId, current => {
      const source = redo ? current.editFuture! : current.editHistory!;
      const destination = redo ? (current.editHistory ??= []) : (current.editFuture ??= []);
      source.pop();
      pushHistoryEntry(destination, { kind: "page", token: entry.token, snapshot: opposite });
      applyAnnotationItems(current, saved.items);
      current.selectedPageIndices = saved.selectedPageIndices;
      current.pageAnchor = saved.pageAnchor;
      current.currentPage = Math.max(0, Math.min(result.pageCount - 1, saved.currentPage));
      current.navigationVersion += 1;
      current.revision = result.revision;
      current.pages = result.pages;
      current.pageCount = result.pageCount;
      current.fileSize = result.fileSize;
      current.contentVersion += 1;
      current.pageDirty = true;
      retainDocumentHistory(current, result.retainedHistoryTokens);
    });
    invalidateOcrForDocument(result.id, result.revision, result.pageCount);
  });
}

function traverse(redo: boolean): Promise<void> {
  const tab = activeTab();
  if (!tab) return Promise.resolve();
  return enqueueDocumentMutation(tab.tabId, () => restore(tab.tabId, redo)).catch(error => {
    emitToast(`${redo ? "다시 실행" : "실행 취소"} 실패: ${error instanceof Error ? error.message : String(error)}`, "error");
  });
}
export const undoDocumentEdit = (): Promise<void> => traverse(false);
export const redoDocumentEdit = (): Promise<void> => traverse(true);
