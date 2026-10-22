// Compensation runs in the existing mutation lane without enqueueing itself.
// Failed compensation blocks later saves/edits until the known PDF generation
// is restored, while leaving newer annotation data intact in the renderer.
const pending = new Map<string, { recover: () => Promise<void>; docId?: string }>();
export function setDocumentHistoryRecovery(tabId: string, recover: () => Promise<void>, docId?: string) {
  pending.set(tabId, {recover, docId});
}
export async function recoverDocumentHistory(tabId: string): Promise<void> {
  const entry = pending.get(tabId);
  if (!entry) return;
  await entry.recover();
  if (pending.get(tabId) === entry) pending.delete(tabId);
}

export function clearDocumentHistoryRecovery(docId: string) {
  for (const [tabId, entry] of pending) if (entry.docId === docId) pending.delete(tabId);
}
