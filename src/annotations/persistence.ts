import { createEffect, onCleanup } from "solid-js";
import { saveAnnotationSidecar } from "../ipc/pdf";
import { documentStore } from "../state/document";
import {
  annotationStore,
  markAnnotationSaveError,
  markAnnotationsSaved,
  setAnnotationSaveStatus,
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

export function installAnnotationAutosave() {
  let timer: number | undefined;

  createEffect(() => {
    const doc = documentStore.doc;
    const dirty = annotationStore.dirty;
    const payload = JSON.stringify(annotationStore.items);

    window.clearTimeout(timer);

    if (!doc || !dirty) {
      return;
    }

    timer = window.setTimeout(async () => {
      try {
        setAnnotationSaveStatus("saving");
        await saveAnnotationSidecar(doc.path, buildAnnotationSidecar(doc.path, JSON.parse(payload)));
        markAnnotationsSaved();
      } catch (error) {
        markAnnotationSaveError(error instanceof Error ? error.message : String(error));
      }
    }, 700);
  });

  onCleanup(() => window.clearTimeout(timer));
}
