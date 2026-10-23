import { emitToast } from "../capture/capture";
import {
  updateTabById,
  type DocumentHistoryEntry,
  type PageEditSnapshot,
  type Tab,
} from "../state/document";

export type { DocumentHistoryEntry, PageEditSnapshot };

export const HISTORY_LIMIT = 80;

export const cloneHistoryValue = <T>(value: T): T => JSON.parse(JSON.stringify(value));

let busyCount = 0;
/** True while a page snapshot restore is in flight; annotation mutators are no-ops then. */
export const historyBusy = (): boolean => busyCount > 0;
export async function withHistoryBusy<T>(task: () => Promise<T>): Promise<T> {
  busyCount += 1;
  try { return await task(); } finally { busyCount -= 1; }
}

export function pushHistoryEntry(stack: DocumentHistoryEntry[], entry: DocumentHistoryEntry) {
  stack.push(entry);
  while (stack.length > HISTORY_LIMIT) stack.shift();
}

export function snapshotPageEdit(tab: Tab): PageEditSnapshot {
  return cloneHistoryValue({ items: tab.annotations.items, selectedPageIndices: tab.selectedPageIndices,
    pageAnchor: tab.pageAnchor, currentPage: tab.currentPage });
}

/** Push the tab's current annotation list as an undo entry and clear redo. */
export function recordAnnotationDocumentHistory(tabId: string) {
  updateTabById(tabId, tab => {
    pushHistoryEntry(tab.editHistory ??= [], { kind: "annotation", items: cloneHistoryValue(tab.annotations.items) });
    tab.editFuture = [];
  });
}

export function retainDocumentHistory(tab: Tab, tokens: string[]) {
  const retained = new Set(tokens);
  // Dropping a structural boundary also drops everything behind it: earlier
  // annotations belong to a page layout we can no longer restore.
  for (const key of ["editHistory", "editFuture"] as const) {
    const entries = tab[key] ?? [];
    let lastExpired = -1;
    entries.forEach((entry, i) => { if (entry.kind === "page" && !retained.has(entry.token)) lastExpired = i; });
    tab[key] = entries.slice(lastExpired + 1);
  }
}

export function commitPageEditHistory(tabId: string, before: PageEditSnapshot, response: object) {
  const result = response as { historyToken?: string; retainedHistoryTokens?: string[] };
  if (result.historyToken && result.retainedHistoryTokens && !result.retainedHistoryTokens.includes(result.historyToken))
    emitToast("문서가 커서 이번 페이지 편집의 실행 취소 기록을 보관할 수 없습니다.");
  updateTabById(tabId, tab => {
    tab.editHistory ??= [];
    if (result.historyToken) pushHistoryEntry(tab.editHistory, { kind: "page", token: result.historyToken, snapshot: before });
    tab.editFuture = [];
    if (result.retainedHistoryTokens) retainDocumentHistory(tab, result.retainedHistoryTokens);
  });
}
