import { createEffect, onCleanup } from "solid-js";
import { flushAnnotationSaveForTab } from "../ipc/pdf";
import { documentStore, type Tab } from "../state/document";
import { markAnnotationSaveErrorForTab } from "./store";
import type { Annotation, AnnotationSidecar } from "./types";
import { sanitizeAnnotation } from "./sanitize";

export const buildAnnotationSidecar = (
  tab: Tab,
  annotations: Annotation[],
): AnnotationSidecar => ({
  version: 2,
  documentKey: tab.annotationDocumentKey,
  sourcePath: tab.path,
  documentRevision: tab.revision,
  pageLayout: tab.pages.map(({ width, height, rotation }) => ({
    width,
    height,
    rotation,
  })),
  updatedAt: new Date().toISOString(),
  annotations: annotations.map(sanitizeAnnotation),
});

/**
 * Autosaves dirty annotations across ALL open tabs (not just the active one) —
 * otherwise an in-progress edit on Tab A could be lost the moment the user
 * switches to Tab B and closes the window.
 */
export function installAnnotationAutosave() {
  const timers = new Map<string, number>();

  createEffect(() => {
    const seen = new Set<string>();
    for (const tab of documentStore.tabs) {
      seen.add(tab.tabId);
      // Page edits and their annotation-coordinate remap must be committed as
      // one transaction by saveTabPdf(). Writing the remapped sidecar while
      // the rotated/reordered PDF still exists only in memory would corrupt
      // alignment if the user later chose "저장 안 함" or the app exited.
      if (!tab.annotations.dirty || tab.pageDirty) {
        const existing = timers.get(tab.tabId);
        if (existing !== undefined) {
          window.clearTimeout(existing);
          timers.delete(tab.tabId);
        }
        continue;
      }

      const tabId = tab.tabId;
      // Track a scalar edit version; capture the payload only when saving.
      tab.annotations.editVersion;

      const existing = timers.get(tabId);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }

      const timer = window.setTimeout(async () => {
        try {
          await flushAnnotationSaveForTab(tabId);
        } catch (error) {
          markAnnotationSaveErrorForTab(
            tabId,
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          // Only drop our own entry — a newer timer may already have been
          // scheduled for this tab under the same key.
          if (timers.get(tabId) === timer) timers.delete(tabId);
        }
      }, 700);
      timers.set(tabId, timer);
    }

    // Drop timers for closed tabs
    for (const tabId of timers.keys()) {
      if (!seen.has(tabId)) {
        window.clearTimeout(timers.get(tabId)!);
        timers.delete(tabId);
      }
    }
  });

  onCleanup(() => {
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
  });
}
