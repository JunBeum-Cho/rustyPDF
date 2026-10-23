import { historyBusy, recordAnnotationDocumentHistory, pushHistoryEntry, cloneHistoryValue } from "../viewer/documentHistoryState";
import {
  activeTab,
  documentStore,
  setDocumentStore,
  updateActiveTab,
  updateTabById,
  type AnnotationTabState,
  type SaveStatus,
} from "../state/document";
import type { Annotation, AnnotationTool } from "./types";
import { sanitizeAnnotationHtml } from "./sanitize";

const isTextColorContext = () => {
  if (documentStore.annotationUi.tool === "text") return true;
  if (documentStore.annotationUi.tool !== "select") return false;
  const annotations = activeTab()?.annotations;
  if (annotations?.editingId) return true;
  const selected = annotations?.items.filter((item) => annotations.selectedIds.includes(item.id)) ?? [];
  return selected.length > 0 && selected.every((item) => item.type === "text");
};

const cloneAnnotations = (items: Annotation[]) =>
  items.map((item) => ({
    ...item,
    rect: item.rect ? { ...item.rect } : undefined,
    points: item.points?.map((point) => ({ ...point })),
    quads: item.quads?.map((quad) => ({ ...quad })),
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
  get tool(): AnnotationTool {
    return documentStore.annotationUi.tool;
  },
  get color(): string {
    return isTextColorContext() ? documentStore.annotationUi.textColor : documentStore.annotationUi.color;
  },
  get textColor(): string {
    return documentStore.annotationUi.textColor;
  },
  get fill(): string {
    return documentStore.annotationUi.fill;
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

const mutateActiveAnnotations = (
  mutator: (state: AnnotationTabState) => void,
) => {
  if (historyBusy()) return;
  updateActiveTab((tab) => {
    mutator(tab.annotations);
  });
};

export const recordAnnotationHistory = () => {
  const tab = activeTab();
  if (tab && !historyBusy()) recordAnnotationDocumentHistory(tab.tabId);
};

const markDirty = () => {
  if (historyBusy()) return;
  updateActiveTab(tab => { tab.editFuture = []; });
  mutateActiveAnnotations((state) => {
    state.editVersion += 1;
    state.dirty = true;
    state.saveStatus = "idle";
    state.saveError = null;
  });
};

/**
 * Add an annotation to a specific tab (the active tab may have changed by the
 * time async work resolves). Records undo history on that tab. Returns false
 * when the tab is gone or a history restore is in flight.
 */
export const addAnnotationToTab = (tabId: string, annotation: Annotation): boolean => {
  if (historyBusy() || findTabIndexSafe(tabId) < 0) return false;
  updateTabById(tabId, (tab) => {
    pushHistoryEntry(tab.editHistory ??= [], { kind: "annotation", items: cloneHistoryValue(tab.annotations.items) });
    tab.editFuture = [];
    tab.annotations.items.push(annotation);
    tab.annotations.selectedIds = [annotation.id];
    tab.annotations.editVersion += 1;
    tab.annotations.dirty = true;
    tab.annotations.saveStatus = "idle";
    tab.annotations.saveError = null;
  });
  return true;
};

const findTabIndexSafe = (tabId: string) => documentStore.tabs.findIndex((tab) => tab.tabId === tabId);

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
  markDirty();
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
  template.innerHTML = sanitizeAnnotationHtml(html);
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
  setAnnotationUiColor(color);
  applyStyleToSelected({ color });
};

export const setAnnotationUiColor = (color: string) => {
  setDocumentStore("annotationUi", isTextColorContext() ? "textColor" : "color", color);
};

export const setAnnotationFillColor = (fill: string) => {
  setDocumentStore("annotationUi", "fill", fill);
  applyStyleToSelected({ fill: fill === "transparent" ? undefined : fill });
};

export const setAnnotationUiFillColor = (fill: string) => {
  setDocumentStore("annotationUi", "fill", fill);
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

/**
 * Live-mirror typed text into the store WHILE editing, without replacing the
 * annotation object. We mutate `payload.html` / `payload.text` on the existing
 * proxy via produce(), so Solid's <For> (keyed by item reference) does NOT
 * dispose/remount the contenteditable row — the caret and any in-flight IME
 * composition stay intact. Records no history (the coarse-grained undo
 * baseline is captured once, at create time or on first edit). Keeping the
 * store current means autosave, Cmd+S, tab switches and window close all see
 * the text on screen instead of an empty/stale value.
 */
export const updateAnnotationTextLive = (
  id: string,
  html: string,
  text: string,
) => {
  if (historyBusy()) return;
  updateActiveTab(tab => { tab.editFuture = []; });
  mutateActiveAnnotations((state) => {
    const item = state.items.find((a) => a.id === id);
    if (!item) return;
    if (!item.payload) item.payload = {};
    item.payload.html = sanitizeAnnotationHtml(html);
    item.payload.text = text;
    state.editVersion += 1;
    state.dirty = true;
    state.saveStatus = "idle";
    state.saveError = null;
  });
};

/**
 * Finalize a text edit on blur/commit: apply the default-style patch and the
 * block-aware plain-text mirror in place (no history — the baseline was
 * already recorded). Mutating nested fields keeps the row's reference stable
 * so the about-to-be-shown read-only view picks up the new values without a
 * remount.
 */
export const finalizeAnnotationText = (
  id: string,
  html: string,
  text: string,
  stylePatch: Partial<Annotation["style"]> = {},
) => {
  if (historyBusy()) return;
  updateActiveTab(tab => { tab.editFuture = []; });
  mutateActiveAnnotations((state) => {
    const item = state.items.find((a) => a.id === id);
    if (!item) return;
    item.style = { ...item.style, ...stylePatch };
    if (!item.payload) item.payload = {};
    item.payload.html = sanitizeAnnotationHtml(html);
    item.payload.text = text;
    state.editVersion += 1;
    state.dirty = true;
    state.saveStatus = "idle";
    state.saveError = null;
  });
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

// ---- Annotation clipboard ----------------------------------------------
// Frontend-only buffer of deep-cloned, page-agnostic annotations. Distinct
// from the page-thumbnail clipboard in viewer/pageClipboard.ts (which round-
// trips PDF bytes through the backend). The keydown handler in pageClipboard.ts
// arbitrates between the two by recency (`copiedAt`).

interface AnnotationClipboard {
  items: Annotation[];
  copiedAt: number;
  /** Bumped per paste so successive copies cascade instead of stacking. */
  pasteCount: number;
}

let annotationClipboard: AnnotationClipboard | null = null;

/** Diagonal offset (PDF points) applied to each successive paste. */
const PASTE_OFFSET = 16;

export const hasAnnotationClipboard = () =>
  annotationClipboard !== null && annotationClipboard.items.length > 0;

/** Timestamp of the last annotation copy/cut, or -1 if the buffer is empty. */
export const annotationClipboardCopiedAt = () =>
  annotationClipboard?.copiedAt ?? -1;

export const copySelectedAnnotations = (): boolean => {
  const tab = activeTab();
  if (!tab) return false;
  const selected = new Set(tab.annotations.selectedIds);
  if (selected.size === 0) return false;
  const items = tab.annotations.items.filter((a) => selected.has(a.id));
  if (items.length === 0) return false;
  annotationClipboard = {
    items: cloneAnnotations(items),
    copiedAt: Date.now(),
    pasteCount: 0,
  };
  return true;
};

export const cutSelectedAnnotations = (): boolean => {
  if (!copySelectedAnnotations()) return false;
  deleteSelectedAnnotations();
  return true;
};

const annotationBounds = (item: Annotation) => {
  const xs: number[] = [];
  const ys: number[] = [];
  if (item.rect) {
    xs.push(item.rect.x, item.rect.x + item.rect.w);
    ys.push(item.rect.y, item.rect.y + item.rect.h);
  }
  for (const p of item.points ?? []) { xs.push(p.x); ys.push(p.y); }
  if (xs.length === 0) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

/** Shift along one axis, limited so [start, start + size] stays inside [0, limit]. */
const clampShift = (start: number, size: number, shift: number, limit: number) => {
  const max = Math.max(0, limit - size);
  const target = Math.min(Math.max(start + shift, 0), max);
  return target - start;
};

export const pasteAnnotations = (): boolean => {
  const tab = activeTab();
  if (historyBusy() || !tab || !annotationClipboard || annotationClipboard.items.length === 0) {
    return false;
  }
  const targetPage = tab.currentPage;
  annotationClipboard.pasteCount += 1;
  const shift = PASTE_OFFSET * annotationClipboard.pasteCount;
  // Clone again so the pasted objects never share nested references with the
  // buffer — repeated pastes (and later moves/resizes) stay independent.
  const meta = tab.pages[targetPage];
  const fresh = cloneAnnotations(annotationClipboard.items).map((item) => {
    item.id = createAnnotationId();
    item.page = targetPage;
    let dx = shift;
    let dy = shift;
    if (meta) {
      const bounds = annotationBounds(item);
      if (bounds) {
        dx = clampShift(bounds.x, bounds.w, shift, meta.width);
        dy = clampShift(bounds.y, bounds.h, shift, meta.height);
      }
    }
    if (item.rect) {
      item.rect = { ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy };
      if (meta && !item.points) {
        item.rect.w = Math.min(item.rect.w, meta.width);
        item.rect.h = Math.min(item.rect.h, meta.height);
      }
    }
    if (item.points) item.points = item.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    if (item.quads) item.quads = item.quads.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy }));
    return item;
  });
  recordAnnotationHistory();
  mutateActiveAnnotations((state) => {
    // push() (not reassignment) keeps existing row proxies stable for <For>.
    for (const item of fresh) state.items.push(item);
    state.selectedIds = fresh.map((i) => i.id);
    state.editingId = null;
  });
  markDirty();
  return true;
};

export const duplicateSelectedAnnotations = (): boolean => {
  if (!copySelectedAnnotations()) return false;
  return pasteAnnotations();
};

export const setAnnotationSaveStatusForTab = (
  tabId: string,
  saveStatus: SaveStatus,
) => {
  updateTabById(tabId, (tab) => {
    tab.annotations.saveStatus = saveStatus;
  });
};

export const markAnnotationSaveErrorForTab = (
  tabId: string,
  message: string,
) => {
  updateTabById(tabId, (tab) => {
    tab.annotations.saveStatus = "error";
    tab.annotations.saveError = message;
  });
};

/**
 * Remap annotation page indices after page-level edits. `mapping[oldPage]`
 * gives the new page index, or `null` if the page was removed. Annotations on
 * removed pages are dropped; surviving annotations are shifted accordingly.
 */
export const remapAnnotationsForTab = (
  tabId: string,
  mapping: Array<number | null>,
  insertedAnnotations: Annotation[] = [],
) => {
  updateTabById(tabId, (tab) => {
    const remapped: Annotation[] = [];
    for (const annotation of tab.annotations.items) {
      const target = mapping[annotation.page];
      if (target == null) continue;
      remapped.push({ ...annotation, page: target });
    }
    // Page duplicate/paste operations copy the PDF page in the backend, while
    // editable annotations live in a sidecar. Add their independently cloned
    // counterparts in the same transaction as the old-page remap so no render
    // can observe a half-updated annotation layout.
    remapped.push(...cloneAnnotations(insertedAnnotations));
    tab.annotations.items = remapped;
    tab.annotations.selectedIds = [];
    tab.annotations.editingId = null;
    tab.annotations.editVersion += 1;
    tab.annotations.dirty = true;
    tab.annotations.saveStatus = "idle";
    tab.annotations.saveError = null;
  });
};

const moveInPage = (
  items: Annotation[],
  id: string,
  moveFn: (pageItems: Annotation[], targetIdx: number) => Annotation[],
): Annotation[] => {
  const target = items.find((a) => a.id === id);
  if (!target) return items;
  const page = target.page;

  const pageItems = items.filter((a) => a.page === page);
  const targetIdx = pageItems.findIndex((a) => a.id === id);
  if (targetIdx < 0) return items;

  const newPageItems = moveFn(pageItems, targetIdx);

  let pageItemIdx = 0;
  return items.map((a) => {
    if (a.page === page) {
      return newPageItems[pageItemIdx++];
    }
    return a;
  });
};

export const bringToFront = (id: string) => {
  const tab = activeTab();
  if (!tab) return;
  recordAnnotationHistory();
  mutateActiveAnnotations((state) => {
    state.items = moveInPage(state.items, id, (pageItems, idx) => {
      const item = pageItems[idx];
      const rest = pageItems.filter((_, i) => i !== idx);
      return [...rest, item];
    });
  });
  markDirty();
};

export const sendToBack = (id: string) => {
  const tab = activeTab();
  if (!tab) return;
  recordAnnotationHistory();
  mutateActiveAnnotations((state) => {
    state.items = moveInPage(state.items, id, (pageItems, idx) => {
      const item = pageItems[idx];
      const rest = pageItems.filter((_, i) => i !== idx);
      return [item, ...rest];
    });
  });
  markDirty();
};

export const bringForward = (id: string) => {
  const tab = activeTab();
  if (!tab) return;
  recordAnnotationHistory();
  mutateActiveAnnotations((state) => {
    state.items = moveInPage(state.items, id, (pageItems, idx) => {
      if (idx === pageItems.length - 1) return pageItems;
      const copy = [...pageItems];
      const temp = copy[idx];
      copy[idx] = copy[idx + 1];
      copy[idx + 1] = temp;
      return copy;
    });
  });
  markDirty();
};

export const sendBackward = (id: string) => {
  const tab = activeTab();
  if (!tab) return;
  recordAnnotationHistory();
  mutateActiveAnnotations((state) => {
    state.items = moveInPage(state.items, id, (pageItems, idx) => {
      if (idx === 0) return pageItems;
      const copy = [...pageItems];
      const temp = copy[idx];
      copy[idx] = copy[idx - 1];
      copy[idx - 1] = temp;
      return copy;
    });
  });
  markDirty();
};
