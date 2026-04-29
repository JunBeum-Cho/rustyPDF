import { createStore, produce } from "solid-js/store";
import type { Annotation, AnnotationTool } from "./types";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface AnnotationState {
  items: Annotation[];
  selectedIds: string[];
  editingId: string | null;
  tool: AnnotationTool;
  color: string;
  strokeWidth: number;
  fontSize: number;
  dirty: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: string | null;
  loadedPath: string | null;
  history: Annotation[][];
  future: Annotation[][];
}

const HISTORY_LIMIT = 80;

const cloneAnnotations = (items: Annotation[]) =>
  items.map((item) => ({
    ...item,
    rect: item.rect ? { ...item.rect } : undefined,
    points: item.points?.map((point) => ({ ...point })),
    style: { ...item.style },
    payload: item.payload ? { ...item.payload } : undefined,
  }));

export const [annotationStore, setAnnotationStore] = createStore<AnnotationState>({
  items: [],
  selectedIds: [],
  editingId: null,
  tool: "select",
  color: "#e11d48",
  strokeWidth: 2,
  fontSize: 16,
  dirty: false,
  saveStatus: "idle",
  saveError: null,
  lastSavedAt: null,
  loadedPath: null,
  history: [],
  future: [],
});

export const createAnnotationId = () => {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const recordAnnotationHistory = () => {
  setAnnotationStore(
    produce((state) => {
      state.history.push(cloneAnnotations(state.items));
      if (state.history.length > HISTORY_LIMIT) {
        state.history.shift();
      }
      state.future = [];
    }),
  );
};

const markDirty = () => {
  setAnnotationStore({
    dirty: true,
    saveStatus: "idle",
    saveError: null,
  });
};

export const replaceAnnotations = (items: Annotation[], path: string | null) => {
  setAnnotationStore({
    items: cloneAnnotations(items),
    selectedIds: [],
    editingId: null,
    dirty: false,
    saveStatus: "idle",
    saveError: null,
    lastSavedAt: null,
    loadedPath: path,
    history: [],
    future: [],
  });
};

export const startEditingAnnotation = (id: string) => {
  setAnnotationStore({ editingId: id });
};

export const stopEditingAnnotation = () => {
  if (annotationStore.editingId) {
    setAnnotationStore({ editingId: null });
  }
};

/**
 * Remove a single annotation. Used when an in-progress text edit is committed
 * empty (treated as a cancel). Records history so the action is undoable.
 */
export const removeAnnotation = (id: string, { record = true }: { record?: boolean } = {}) => {
  if (record) {
    recordAnnotationHistory();
  }
  setAnnotationStore(
    produce((state) => {
      state.items = state.items.filter((annotation) => annotation.id !== id);
      state.selectedIds = state.selectedIds.filter((selectedId) => selectedId !== id);
      if (state.editingId === id) {
        state.editingId = null;
      }
    }),
  );
  if (record) {
    markDirty();
  }
};

export const setAnnotationTool = (tool: AnnotationTool) => {
  setAnnotationStore({ tool });
};

const applyStyleToSelected = (patch: Partial<Annotation["style"]>) => {
  if (annotationStore.selectedIds.length === 0) {
    return;
  }
  const selected = new Set(annotationStore.selectedIds);
  recordAnnotationHistory();
  setAnnotationStore(
    produce((state) => {
      state.items = state.items.map((annotation) => {
        if (!selected.has(annotation.id)) {
          return annotation;
        }
        const nextStyle = { ...annotation.style, ...patch };
        if (annotation.type === "highlight") {
          if (patch.color !== undefined) {
            nextStyle.fill = patch.color;
          }
          nextStyle.width = 0;
        }
        return { ...annotation, style: nextStyle };
      });
    }),
  );
  markDirty();
};

export const setAnnotationColor = (color: string) => {
  setAnnotationStore({ color });
  applyStyleToSelected({ color });
};

export const setAnnotationStrokeWidth = (strokeWidth: number) => {
  setAnnotationStore({ strokeWidth });
  applyStyleToSelected({ width: strokeWidth });
};

export const setAnnotationFontSize = (fontSize: number) => {
  setAnnotationStore({ fontSize });
  applyStyleToSelected({ fontSize });
};

export const selectAnnotation = (id: string, append = false) => {
  setAnnotationStore(
    produce((state) => {
      if (append) {
        if (state.selectedIds.includes(id)) {
          state.selectedIds = state.selectedIds.filter((selectedId) => selectedId !== id);
        } else {
          state.selectedIds.push(id);
        }
      } else {
        state.selectedIds = [id];
      }
    }),
  );
};

export const clearAnnotationSelection = () => {
  setAnnotationStore({ selectedIds: [] });
};

export const addAnnotation = (annotation: Annotation) => {
  recordAnnotationHistory();
  setAnnotationStore(
    produce((state) => {
      state.items.push(annotation);
      state.selectedIds = [annotation.id];
    }),
  );
  markDirty();
};

export const updateAnnotation = (
  id: string,
  updater: (annotation: Annotation) => Annotation,
) => {
  recordAnnotationHistory();
  updateAnnotationLive(id, updater);
};

export const updateAnnotationLive = (
  id: string,
  updater: (annotation: Annotation) => Annotation,
) => {
  setAnnotationStore(
    produce((state) => {
      const index = state.items.findIndex((annotation) => annotation.id === id);
      if (index >= 0) {
        state.items[index] = updater(state.items[index]);
      }
    }),
  );
  markDirty();
};

export const updateAnnotationsLive = (
  ids: string[],
  updater: (annotation: Annotation) => Annotation,
) => {
  setAnnotationStore(
    produce((state) => {
      const selected = new Set(ids);
      state.items = state.items.map((annotation) =>
        selected.has(annotation.id) ? updater(annotation) : annotation,
      );
    }),
  );
  markDirty();
};

export const deleteSelectedAnnotations = () => {
  if (annotationStore.selectedIds.length === 0) {
    return;
  }
  const selected = new Set(annotationStore.selectedIds);
  recordAnnotationHistory();
  setAnnotationStore(
    produce((state) => {
      state.items = state.items.filter((annotation) => !selected.has(annotation.id));
      state.selectedIds = [];
    }),
  );
  markDirty();
};

export const undoAnnotations = () => {
  if (annotationStore.history.length === 0) {
    return;
  }
  setAnnotationStore(
    produce((state) => {
      const previous = state.history.pop();
      if (!previous) {
        return;
      }
      state.future.push(cloneAnnotations(state.items));
      state.items = previous;
      state.selectedIds = [];
      state.dirty = true;
      state.saveStatus = "idle";
      state.saveError = null;
    }),
  );
};

export const redoAnnotations = () => {
  if (annotationStore.future.length === 0) {
    return;
  }
  setAnnotationStore(
    produce((state) => {
      const next = state.future.pop();
      if (!next) {
        return;
      }
      state.history.push(cloneAnnotations(state.items));
      state.items = next;
      state.selectedIds = [];
      state.dirty = true;
      state.saveStatus = "idle";
      state.saveError = null;
    }),
  );
};

export const setAnnotationSaveStatus = (saveStatus: SaveStatus) => {
  setAnnotationStore({ saveStatus });
};

export const markAnnotationsSaved = () => {
  setAnnotationStore({
    dirty: false,
    saveStatus: "saved",
    saveError: null,
    lastSavedAt: new Date().toISOString(),
  });
};

export const markAnnotationSaveError = (message: string) => {
  setAnnotationStore({
    saveStatus: "error",
    saveError: message,
  });
};
