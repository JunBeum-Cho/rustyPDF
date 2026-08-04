import { createEffect, onCleanup } from "solid-js";
import { saveAnnotationSidecar } from "../ipc/pdf";
import { enqueueDocumentMutation } from "../ipc/documentMutations";
import { documentStore, updateTabById, type Tab } from "../state/document";
import {
  markAnnotationSaveErrorForTab,
  setAnnotationSaveStatusForTab,
} from "./store";
import type { Annotation, AnnotationSidecar } from "./types";

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
  annotations,
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
      // Reading the serialized payload makes item edits a dependency of this
      // debounce effect. The authoritative snapshot is captured later, when
      // the queued save actually starts.
      JSON.stringify(tab.annotations.items);

      const existing = timers.get(tabId);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }

      const timer = window.setTimeout(async () => {
        try {
          await enqueueDocumentMutation(tabId, async () => {
            const current = documentStore.tabs.find(
              (candidate) => candidate.tabId === tabId,
            );
            // A queued structural edit/save may have superseded this timer.
            if (!current || !current.annotations.dirty || current.pageDirty) {
              return;
            }
            const snapshot = JSON.stringify(current.annotations.items);
            setAnnotationSaveStatusForTab(tabId, "saving");
            await saveAnnotationSidecar(
              current.docId,
              current.revision,
              current.path,
              buildAnnotationSidecar(current, JSON.parse(snapshot)),
            );
            updateTabById(tabId, (latest) => {
              if (JSON.stringify(latest.annotations.items) === snapshot) {
                latest.annotations.dirty = false;
                latest.annotations.saveStatus = "saved";
                latest.annotations.lastSavedAt = new Date().toISOString();
              } else {
                latest.annotations.saveStatus = "idle";
              }
              latest.annotations.saveError = null;
            });
          });
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
