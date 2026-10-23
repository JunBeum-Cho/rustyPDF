import { createEffect, onCleanup } from "solid-js";
import { invoke } from "../platform/desktop";
import { documentStore } from "../state/document";
import { sanitizeAnnotation } from "./sanitize";

export const DRAFT_DEBOUNCE_MS = 1000;

/**
 * Write the crash-recovery draft for one tab. Drafts never touch the PDF.
 * Tabs with unsaved page edits are skipped: their annotation page indices no
 * longer match the file on disk, so restoring them after a crash would misalign.
 */
export async function writeDraftForTab(tabId: string): Promise<void> {
  const tab = documentStore.tabs.find((t) => t.tabId === tabId);
  if (!tab || !tab.annotations.dirty || tab.pageDirty) return;
  if (tab.isUnsaved || tab.readOnly || tab.path.startsWith("unsaved://")) return;
  const annotations = (
    JSON.parse(JSON.stringify(tab.annotations.items)) as unknown[]
  ).map((item) => sanitizeAnnotation(item as never));
  const json = JSON.stringify({ savedAt: new Date().toISOString(), annotations });
  await invoke("draft_write", { path: tab.path, json });
}

/** Debounced draft writes for dirty tabs, keyed on their edit version. */
export function installDraftAutosave() {
  const timers = new Map<string, number>();

  createEffect(() => {
    const seen = new Set<string>();
    for (const tab of documentStore.tabs) {
      seen.add(tab.tabId);
      const tabId = tab.tabId;
      const existing = timers.get(tabId);
      if (existing !== undefined) {
        window.clearTimeout(existing);
        timers.delete(tabId);
      }
      // Tracked so every edit restarts the debounce.
      void tab.annotations.editVersion;
      if (!tab.annotations.dirty || tab.pageDirty || tab.isUnsaved || tab.readOnly) continue;

      const timer = window.setTimeout(() => {
        if (timers.get(tabId) === timer) timers.delete(tabId);
        writeDraftForTab(tabId).catch((error) =>
          console.error("draft write failed", error),
        );
      }, DRAFT_DEBOUNCE_MS);
      timers.set(tabId, timer);
    }
    for (const [tabId, timer] of [...timers]) {
      if (!seen.has(tabId)) {
        window.clearTimeout(timer);
        timers.delete(tabId);
      }
    }
  });

  onCleanup(() => {
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
  });
}
