import { setDocumentHistoryRecovery, recoverDocumentHistory } from "./documentHistoryRecovery";
import { activeTab, documentStore, updateTabById, type PageMeta } from "../state/document";
import { invalidateOcrForDocument } from "../ocr/ocr";
import { invoke } from "../platform/desktop";
import { enqueueDocumentMutation } from "../ipc/documentMutations";
import { undoAnnotations, redoAnnotations } from "../annotations/store";
import { emitToast } from "../capture/capture";
import { snapshotPageEdit, cloneHistoryValue, retainDocumentHistory } from "./documentHistoryState";

export const canUndoDocumentEdit = (): boolean => (activeTab()?.editHistory?.length ?? 0) > 0;
export const canRedoDocumentEdit = (): boolean => (activeTab()?.editFuture?.length ?? 0) > 0;

async function restore(tabId: string, redo: boolean) {
  const tab = documentStore.tabs.find(t => t.tabId === tabId);
  if (!tab) return;
  const entry = (redo ? tab.editFuture : tab.editHistory)?.at(-1);
  if (!entry) return;
  if (entry.kind === "annotation") {
    if (redo) redoAnnotations(tabId); else undoAnnotations(tabId);
    return;
  }
  const revision = tab.revision;
  const annotationVersion = tab.annotations.editVersion;
  const result = await invoke<{id:string;revision:number;pages:PageMeta[];pageCount:number;fileSize:number;retainedHistoryTokens:string[];restoreTransaction?:string}>("pdf_restore_snapshot", {
    docId:tab.docId, expectedRevision:revision, token:entry.token, transactional:true,
  });
  const live = documentStore.tabs.find(t => t.tabId === tabId);
  if (!live) return;
  if (live.docId !== result.id || live.revision !== revision || result.revision !== revision + 1)
    throw new Error("문서가 변경되어 실행 취소 결과를 적용하지 않았습니다.");
  // Annotation interactions are synchronous and can arrive while IPC is in
  // flight. Cancel this traversal by swapping the PDF back, preserving those
  // newer edits and their ordered history instead of replacing them.
  if (live.annotations.editVersion !== annotationVersion) {
    setDocumentHistoryRecovery(tabId, async () => {
      const current = documentStore.tabs.find(t => t.tabId === tabId);
      if (!current || current.docId !== result.id) return;
      const compensation = await invoke<typeof result>(result.restoreTransaction ? "pdf_rollback_restore" : "pdf_restore_snapshot", {
        docId: result.id, expectedRevision: result.revision, token: entry.token, restoreTransaction:result.restoreTransaction,
      });
      updateTabById(tabId, target => {
        target.revision = compensation.revision;
        target.contentVersion += 1;
        retainDocumentHistory(target, compensation.retainedHistoryTokens);
      });
      invalidateOcrForDocument(result.id, compensation.revision, compensation.pageCount);
    }, result.id);
    try {
      await recoverDocumentHistory(tabId);
    } catch {
      // Retry one transient bridge failure immediately. Persistent failure
      // remains pending and blocks the next queued operation before it runs.
      await recoverDocumentHistory(tabId);
    }
    emitToast("새 편집이 추가되어 실행 취소/다시 실행을 취소했습니다. 다시 시도해 주세요.");
    return;
  }
  const opposite = snapshotPageEdit(live);
  updateTabById(tabId, current => {
    const source = redo ? (current.editFuture ??= []) : (current.editHistory ??= []);
    const destination = redo ? (current.editHistory ??= []) : (current.editFuture ??= []);
    source.pop();
    destination.push({kind:"page",token:entry.token,snapshot:opposite});
    const saved = cloneHistoryValue(entry.snapshot);
    const version = current.annotations.editVersion;
    const lastSavedAt = current.annotations.lastSavedAt;
    current.annotations = saved.annotations;
    current.annotations.editVersion = version + 1;
    current.annotations.lastSavedAt = lastSavedAt;
    current.annotations.dirty = true;
    current.annotations.saveStatus = "idle";
    current.annotations.saveError = null;
    current.annotations.editingId = null;
    current.selectedPageIndices = saved.selectedPageIndices;
    current.pageAnchor = saved.pageAnchor;
    current.currentPage = Math.min(result.pageCount - 1, saved.currentPage);
    current.navigationVersion += 1;
    current.revision = result.revision;
    current.pages = result.pages;
    current.pageCount = result.pageCount;
    current.fileSize = result.fileSize;
    current.contentVersion += 1;
    current.pageDirty = true;
    current.rotation = 0;
    retainDocumentHistory(current, result.retainedHistoryTokens);
  });
  invalidateOcrForDocument(result.id, result.revision, result.pageCount);
  if (result.restoreTransaction) {
    setDocumentHistoryRecovery(tabId, async () => {
      const current = documentStore.tabs.find(t => t.tabId === tabId);
      if (!current || current.docId !== result.id) return;
      await invoke("pdf_accept_restore", {docId:result.id, expectedRevision:result.revision, restoreTransaction:result.restoreTransaction});
    }, result.id);
    try { await recoverDocumentHistory(tabId); }
    catch { await recoverDocumentHistory(tabId); }
  }
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
