import { createEffect, onCleanup } from "solid-js";
import { saveAnnotationSidecar } from "../ipc/pdf";
import { documentStore } from "../state/document";
import {
  markAnnotationsSavedForTab,
  markAnnotationSaveErrorForTab,
  setAnnotationSaveStatusForTab,
} from "./store";
import type { Annotation, AnnotationSidecar } from "./types";

export const buildAnnotationSidecar = (
  sourcePath: string,
  annotations: Annotation[],
): AnnotationSidecar => ({
  version: 1,
  sourcePath,
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
      if (!tab.annotations.dirty) {
        const existing = timers.get(tab.tabId);
        if (existing !== undefined) {
          window.clearTimeout(existing);
          timers.delete(tab.tabId);
        }
        continue;
      }

      const tabId = tab.tabId;
      const path = tab.path;
      const payload = JSON.stringify(tab.annotations.items);

      const existing = timers.get(tabId);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }

      const timer = window.setTimeout(async () => {
        try {
          setAnnotationSaveStatusForTab(tabId, "saving");
          await saveAnnotationSidecar(
            path,
            buildAnnotationSidecar(path, JSON.parse(payload)),
          );
          markAnnotationsSavedForTab(tabId);
        } catch (error) {
          markAnnotationSaveErrorForTab(
            tabId,
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          timers.delete(tabId);
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
