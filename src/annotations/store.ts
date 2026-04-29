import {
  activeTab,
  documentStore,
  emptyAnnotationTabState,
  findTabIndex,
  setDocumentStore,
  updateActiveTab,
  updateTabById,
  type AnnotationTabState,
  type SaveStatus,
} from "../state/document";
import type { Annotation, AnnotationTool } from "./types";

const HISTORY_LIMIT = 80;

const cloneAnnotations = (items: Annotation[]) =>
  items.map((item) => ({
    ...item,
    rect: item.rect ? { ...item.rect } : undefined,
    points: item.points?.map((point) => ({ ...point })),
    style: { ...item.style },
    payload: item.payload ? { ...item.payload } : undefined,
  }));

/**
 * Facade over `documentStore.tabs[active].annotations` so the rest of the app
 * keeps a single import surface. Reads are getters (reactive), writes target
 * the active tab.
 */
export const annotationStore = {
  get items(): Annotation[] {
    return activeTab()?.annotations.items ?? [];
  },
  get selectedIds(): string[] {
    return activeTab()?.annotations.selectedIds ?? [];
  },
  get editingId(): string | null {
    return activeTab()?.annotations.editingId ?? null;
  },
  get dirty(): boolean {
    return activeTab()?.annotations.dirty ?? false;
  },
  get saveStatus(): SaveStatus {
    return activeTab()?.annotations.saveStatus ?? "idle";
  },
  get saveError(): string | null {
    return activeTab()?.annotations.saveError ?? null;
  },
  get lastSavedAt(): string | null {
    return activeTab()?.annotations.lastSavedAt ?? null;
  },
  get history(): Annotation[][] {
    return activeTab()?.annotations.history ?? [];
  },
  get future(): Annotation[][] {
    return activeTab()?.annotations.future ?? [];
  },
  get tool(): AnnotationTool {
    return documentStore.annotationUi.tool;
  },
  get color(): string {
    return documentStore.annotationUi.color;
  },
  get strokeWidth(): number {
    return documentStore.annotationUi.strokeWidth;
  },
  get fontSize(): number {
    return documentStore.annotationUi.fontSize;
  },
  get fontFamily(): string {
    return documentStore.annotationUi.fontFamily;
  },
};

export const createAnnotationId = () => {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const mutateActiveAnnotations = (mutator: (state: AnnotationTabState) => void) => {
  updateActiveTab((tab) => {
    mutator(tab.annotations);
  });
};

export const recordAnnotationHistory = () => {
  mutateActiveAnnotations((state) => {
    state.history.push(cloneAnnotations(state.items));
    if (state.history.length > HISTORY_LIMIT) {
      state.history.shift();
    }
    state.future = [];
  });
};

const markDirty = () => {
  mutateActiveAnnotations((state) => {
    state.dirty = true;
    state.saveStatus = "idle";
    state.saveError = null;
  });
};

/**
 * Reset annotations for a specific tab — used on initial load and on doc
 * reload. Pass `tabId` because the active tab may already have changed by the
 * time async loads resolve.
 */
export const replaceAnnotationsForTab = (tabId: string, items: Annotation[]) => {
  if (findTabIndex(tabId) < 0) return;
  updateTabById(tabId, (tab) => {
    tab.annotations = emptyAnnotationTabState();
    tab.annotations.items = cloneAnnotations(items);
  });
};

export const startEditingAnnotation = (id: string) => {
  mutateActiveAnnotations((state) => {
    state.editingId = id;
  });
};

export const stopEditingAnnotation = () => {
  if (!annotationStore.editingId) return;
  mutateActiveAnnotations((state) => {
    state.editingId = null;
  });
};

export const removeAnnotation = (
  id: string,
  { record = true }: { record?: boolean } = {},
) => {
  if (record) {
    recordAnnotationHistory();
  }
  mutateActiveAnnotations((state) => {
    state.items = state.items.filter((a) => a.id !== id);
    state.selectedIds = state.selectedIds.filter((sid) => sid !== id);
    if (state.editingId === id) state.editingId = null;
  });
  if (record) {
    markDirty();
  }
};

export const setAnnotationTool = (tool: AnnotationTool) => {
  setDocumentStore("annotationUi", "tool", tool);
};

const patchTouchesTextDisplay = (patch: Partial<Annotation["style"]>) =>
  patch.color !== undefined ||
  patch.fontSize !== undefined ||
  patch.fontFamily !== undefined ||
  patch.fontWeight !== undefined ||
  patch.fontStyle !== undefined ||
  patch.textDecoration !== undefined ||
  patch.textAlign !== undefined;

const unwrapElements = (root: DocumentFragment, selector: string) => {
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element);
    }
    parent.removeChild(element);
  });
};

const stripTextStyleOverrides = (
  html: string,
  patch: Partial<Annotation["style"]>,
) => {
  if (!html || typeof document === "undefined") return html;

  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLElement>("*").forEach((element) => {
    if (patch.color !== undefined) {
      element.style.removeProperty("color");
      element.removeAttribute("color");
    }
    if (patch.fontSize !== undefined) {
      element.style.removeProperty("font-size");
      element.removeAttribute("size");
    }
    if (patch.fontFamily !== undefined) {
      element.style.removeProperty("font-family");
      element.removeAttribute("face");
    }
    if (patch.fontWeight !== undefined) {
      element.style.removeProperty("font-weight");
    }
    if (patch.fontStyle !== undefined) {
      element.style.removeProperty("font-style");
    }
    if (patch.textDecoration !== undefined) {
      element.style.removeProperty("text-decoration");
      element.style.removeProperty("text-decoration-line");
    }
    if (patch.textAlign !== undefined) {
      element.style.removeProperty("text-align");
      element.removeAttribute("align");
    }
    if (element.getAttribute("style")?.trim() === "") {
      element.removeAttribute("style");
    }
  });
  if (patch.fontWeight !== undefined) {
    unwrapElements(template.content, "b,strong");
  }
  if (patch.fontStyle !== undefined) {
    unwrapElements(template.content, "i,em");
  }
  if (patch.textDecoration !== undefined) {
    unwrapElements(template.content, "u");
  }

  return template.innerHTML;
};

const applyStyleToSelected = (patch: Partial<Annotation["style"]>) => {
  const tab = activeTab();
  if (!tab) return;
  if (tab.annotations.selectedIds.length === 0) return;
  const selected = new Set(tab.annotations.selectedIds);
  recordAnnotationHistory();
  mutateActiveAnnotations((state) => {
    state.items = state.items.map((annotation) => {
      if (!selected.has(annotation.id)) return annotation;
      const nextStyle = { ...annotation.style, ...patch };
      if (annotation.type === "highlight") {
        if (patch.color !== undefined) nextStyle.fill = patch.color;
        nextStyle.width = 0;
      }
      if (
        annotation.type === "text" &&
        patchTouchesTextDisplay(patch) &&
        annotation.payload?.html
      ) {
        return {
          ...annotation,
          style: nextStyle,
          payload: {
            ...annotation.payload,
            html: stripTextStyleOverrides(annotation.payload.html, patch),
          },
        };
      }
      return { ...annotation, style: nextStyle };
    });
  });
  markDirty();
};

export const setAnnotationColor = (color: string) => {
  setDocumentStore("annotationUi", "color", color);
  applyStyleToSelected({ color });
};

export const setAnnotationUiColor = (color: string) => {
  setDocumentStore("annotationUi", "color", color);
};

export const setAnnotationStrokeWidth = (strokeWidth: number) => {
  setDocumentStore("annotationUi", "strokeWidth", strokeWidth);
  applyStyleToSelected({ width: strokeWidth });
};

export const setAnnotationFontSize = (fontSize: number) => {
  setDocumentStore("annotationUi", "fontSize", fontSize);
  applyStyleToSelected({ fontSize });
};

export const setAnnotationUiFontSize = (fontSize: number) => {
  setDocumentStore("annotationUi", "fontSize", fontSize);
};

export const setAnnotationFontFamily = (fontFamily: string) => {
  setDocumentStore("annotationUi", "fontFamily", fontFamily);
  applyStyleToSelected({ fontFamily });
};

export const setAnnotationUiFontFamily = (fontFamily: string) => {
  setDocumentStore("annotationUi", "fontFamily", fontFamily);
};

const selectedTextAnnotations = () => {
  const tab = activeTab();
  if (!tab) return [];
  const selected = new Set(tab.annotations.selectedIds);
  return tab.annotations.items.filter(
    (annotation) => annotation.type === "text" && selected.has(annotation.id),
  );
};

export const hasSelectedTextAnnotation = () =>
  selectedTextAnnotations().length > 0;

export const toggleSelectedTextBold = () => {
  const selected = selectedTextAnnotations();
  if (selected.length === 0) return;
  const allBold = selected.every(
    (annotation) =>
      annotation.style.fontWeight === "700" ||
      annotation.style.fontWeight === "bold",
  );
  applyStyleToSelected({ fontWeight: allBold ? "normal" : "700" });
};

export const toggleSelectedTextItalic = () => {
  const selected = selectedTextAnnotations();
  if (selected.length === 0) return;
  const allItalic = selected.every(
    (annotation) => annotation.style.fontStyle === "italic",
  );
  applyStyleToSelected({ fontStyle: allItalic ? "normal" : "italic" });
};

export const toggleSelectedTextUnderline = () => {
  const selected = selectedTextAnnotations();
  if (selected.length === 0) return;
  const allUnderlined = selected.every(
    (annotation) => annotation.style.textDecoration === "underline",
  );
  applyStyleToSelected({
    textDecoration: allUnderlined ? "none" : "underline",
  });
};

export const alignSelectedText = (
  textAlign: NonNullable<Annotation["style"]["textAlign"]>,
) => {
  if (selectedTextAnnotations().length === 0) return;
  applyStyleToSelected({ textAlign });
};

export const selectAnnotation = (id: string, append = false) => {
  mutateActiveAnnotations((state) => {
    if (append) {
      if (state.selectedIds.includes(id)) {
        state.selectedIds = state.selectedIds.filter((sid) => sid !== id);
      } else {
        state.selectedIds.push(id);
      }
    } else {
      state.selectedIds = [id];
    }
  });
};

export const clearAnnotationSelection = () => {
  mutateActiveAnnotations((state) => {
    state.selectedIds = [];
  });
};

export const addAnnotation = (annotation: Annotation) => {
  recordAnnotationHistory();
  mutateActiveAnnotations((state) => {
    state.items.push(annotation);
    state.selectedIds = [annotation.id];
  });
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
  mutateActiveAnnotations((state) => {
    const idx = state.items.findIndex((a) => a.id === id);
    if (idx >= 0) state.items[idx] = updater(state.items[idx]);
  });
  markDirty();
};

export const updateAnnotationsLive = (
  ids: string[],
  updater: (annotation: Annotation) => Annotation,
) => {
  mutateActiveAnnotations((state) => {
    const selected = new Set(ids);
    state.items = state.items.map((a) => (selected.has(a.id) ? updater(a) : a));
  });
  markDirty();
};

export const deleteSelectedAnnotations = () => {
  const tab = activeTab();
  if (!tab || tab.annotations.selectedIds.length === 0) return;
  const selected = new Set(tab.annotations.selectedIds);
  recordAnnotationHistory();
  mutateActiveAnnotations((state) => {
    state.items = state.items.filter((a) => !selected.has(a.id));
    state.selectedIds = [];
  });
  markDirty();
};

export const undoAnnotations = () => {
  const tab = activeTab();
  if (!tab || tab.annotations.history.length === 0) return;
  mutateActiveAnnotations((state) => {
    const previous = state.history.pop();
    if (!previous) return;
    state.future.push(cloneAnnotations(state.items));
    state.items = previous;
    state.selectedIds = [];
    state.dirty = true;
    state.saveStatus = "idle";
    state.saveError = null;
  });
};

export const redoAnnotations = () => {
  const tab = activeTab();
  if (!tab || tab.annotations.future.length === 0) return;
  mutateActiveAnnotations((state) => {
    const next = state.future.pop();
    if (!next) return;
    state.history.push(cloneAnnotations(state.items));
    state.items = next;
    state.selectedIds = [];
    state.dirty = true;
    state.saveStatus = "idle";
    state.saveError = null;
  });
};

export const setAnnotationSaveStatusForTab = (
  tabId: string,
  saveStatus: SaveStatus,
) => {
  updateTabById(tabId, (tab) => {
    tab.annotations.saveStatus = saveStatus;
  });
};

export const markAnnotationsSavedForTab = (tabId: string) => {
  updateTabById(tabId, (tab) => {
    tab.annotations.dirty = false;
    tab.annotations.saveStatus = "saved";
    tab.annotations.saveError = null;
    tab.annotations.lastSavedAt = new Date().toISOString();
  });
};

export const markAnnotationSaveErrorForTab = (tabId: string, message: string) => {
  updateTabById(tabId, (tab) => {
    tab.annotations.saveStatus = "error";
    tab.annotations.saveError = message;
  });
};

/**
 * Remap annotation page indices after page-level edits. `mapping[oldPage]`
 * gives the new page index, or `null` if the page was removed. Annotations on
 * removed pages are dropped; surviving annotations are shifted accordingly.
 * Clears history because positions no longer line up with prior snapshots.
 */
export const remapAnnotationsForTab = (
  tabId: string,
  mapping: Array<number | null>,
) => {
  updateTabById(tabId, (tab) => {
    const remapped: Annotation[] = [];
    for (const annotation of tab.annotations.items) {
      const target = mapping[annotation.page];
      if (target == null) continue;
      remapped.push({ ...annotation, page: target });
    }
    tab.annotations.items = remapped;
    tab.annotations.history = [];
    tab.annotations.future = [];
    tab.annotations.selectedIds = [];
    tab.annotations.editingId = null;
    tab.annotations.dirty = true;
  });
};
