import { emitToast } from "../capture/capture";
import { updateTabById, type AnnotationTabState, type Tab } from "../state/document";
export interface PageEditSnapshot {
  annotations: AnnotationTabState;
  selectedPageIndices: number[];
  pageAnchor: number | null;
  currentPage: number;
}
export type DocumentHistoryEntry = { kind: "annotation" } | {
  kind: "page";
  token: string;
  snapshot: PageEditSnapshot;
};
export const cloneHistoryValue = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function snapshotPageEdit(tab: Tab): PageEditSnapshot {
  return cloneHistoryValue({ annotations: tab.annotations, selectedPageIndices: tab.selectedPageIndices,
    pageAnchor: tab.pageAnchor, currentPage: tab.currentPage });
}
export function recordAnnotationDocumentHistory(tabId: string) {
  updateTabById(tabId, tab => {
    tab.editHistory ??= [];
    tab.editHistory.push({ kind: "annotation" });
    if (tab.editHistory.length > 80) tab.editHistory.shift();
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
export function commitPageEditHistory(tabId: string, before: PageEditSnapshot,
  response: object) {
  const result = response as { historyToken?: string; retainedHistoryTokens?: string[] };
  if (result.historyToken && result.retainedHistoryTokens && !result.retainedHistoryTokens.includes(result.historyToken))
    emitToast("문서가 커서 이번 페이지 편집의 실행 취소 기록을 보관할 수 없습니다.");
  updateTabById(tabId, tab => {
    tab.editHistory ??= [];
    if (result.historyToken) tab.editHistory.push({kind:"page",token:result.historyToken,snapshot:before});
    tab.editFuture = [];
    if (result.retainedHistoryTokens) retainDocumentHistory(tab, result.retainedHistoryTokens);
  });
}
