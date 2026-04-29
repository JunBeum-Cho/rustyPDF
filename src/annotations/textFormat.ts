/**
 * Rich-text formatting helpers for the contenteditable text annotation editor.
 *
 * We rely on `document.execCommand` for the bulk of the work — it's
 * formally deprecated but every Chromium/WebKit engine still implements it,
 * and writing an equivalent Range/Selection-based engine is a project of its
 * own. The user's request was per-selection styling (not whole-block), which
 * execCommand handles natively.
 *
 * Buttons that drive these helpers MUST call `event.preventDefault()` on
 * mousedown — otherwise the browser moves focus to the button and the
 * editor's selection collapses, leaving execCommand with nothing to act on.
 */

import { activeTab } from "../state/document";
import { startEditingAnnotation } from "./store";

let lastFocusedEditor: HTMLElement | null = null;
// Snapshot of the editor's selection at the moment we last saw the editor
// focused. Color pickers, <select> dropdowns and number inputs all steal
// focus from the contenteditable when the user clicks them, which clears
// the selection — re-focusing the editor afterwards only restores a caret,
// not the highlighted range. We capture the live range here via the
// `selectionchange` listener and replay it before applying any command.
let savedRange: Range | null = null;

export interface TextStylePatch {
  color?: string;
  fontSize?: number;
  fontFamily?: string;
}

export const registerEditor = (el: HTMLElement) => {
  lastFocusedEditor = el;
  ensureSelectionTracker();
};

export const unregisterEditor = (el: HTMLElement) => {
  if (lastFocusedEditor === el) lastFocusedEditor = null;
};

let selectionTrackerInstalled = false;
function ensureSelectionTracker() {
  if (selectionTrackerInstalled) return;
  selectionTrackerInstalled = true;
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // Only remember selections inside an annotation contenteditable; other
    // selections (toolbar inputs, page text-layer drags) shouldn't clobber
    // the editor's range.
    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== document.body) {
      if (
        node instanceof HTMLElement &&
        node.isContentEditable &&
        node.classList.contains("annotation-text-edit")
      ) {
        savedRange = range.cloneRange();
        return;
      }
      node = node.parentNode;
    }
  });
}

export const getActiveEditor = (): HTMLElement | null => {
  const active = document.activeElement as HTMLElement | null;
  if (active && active.isContentEditable && active.classList.contains("annotation-text-edit")) {
    return active;
  }
  return lastFocusedEditor;
};

/**
 * If a text annotation is selected but not yet in edit mode, flip it into
 * edit mode. Returns true if it took action — the caller should defer the
 * actual format command until the contenteditable mounts (use rAF).
 */
const tryEnterEditMode = (): boolean => {
  const tab = activeTab();
  if (!tab) return false;
  if (tab.annotations.editingId) return false;
  const candidate = tab.annotations.items.find(
    (a) => a.type === "text" && tab.annotations.selectedIds.includes(a.id),
  );
  if (!candidate) return false;
  startEditingAnnotation(candidate.id);
  return true;
};

const selectAllInEditor = (editor: HTMLElement) => {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(range);
};

const editorContainsNode = (editor: HTMLElement, node: Node) =>
  node === editor || editor.contains(node);

const currentRangeInEditor = (editor: HTMLElement): Range | null => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return editorContainsNode(editor, range.commonAncestorContainer) ? range : null;
};

const editorZoom = (editor: HTMLElement) => {
  const zoom = Number(editor.dataset.annotationZoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
};

const applyEditorDefaultStyle = (
  editor: HTMLElement,
  patch: TextStylePatch,
) => {
  if (patch.color !== undefined) {
    editor.style.color = patch.color;
    editor.dataset.annotationColor = patch.color;
  }
  if (patch.fontSize !== undefined) {
    editor.style.fontSize = `${patch.fontSize * editorZoom(editor)}px`;
    editor.dataset.annotationFontSize = String(patch.fontSize);
  }
  if (patch.fontFamily !== undefined) {
    editor.style.fontFamily = patch.fontFamily;
    editor.dataset.annotationFontFamily = patch.fontFamily;
  }
};

export const readEditorStylePatch = (editor: HTMLElement): TextStylePatch => {
  const patch: TextStylePatch = {};
  if (editor.dataset.annotationColor) {
    patch.color = editor.dataset.annotationColor;
  }
  const fontSize = Number(editor.dataset.annotationFontSize);
  if (Number.isFinite(fontSize) && fontSize > 0) {
    patch.fontSize = fontSize;
  }
  if (editor.dataset.annotationFontFamily) {
    patch.fontFamily = editor.dataset.annotationFontFamily;
  }
  return patch;
};

const restoreSelectionInto = (editor: HTMLElement) => {
  if (document.activeElement !== editor) editor.focus();
  if (!savedRange) return;
  // Only restore if the saved range still belongs to this editor — safer
  // than dropping a stale range from a different annotation.
  if (!editor.contains(savedRange.commonAncestorContainer)) return;
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(savedRange);
};

const runCommandOnEditor = (
  editor: HTMLElement,
  command: string,
  value?: string,
) => {
  restoreSelectionInto(editor);
  const range = currentRangeInEditor(editor);
  if (!range || range.collapsed) {
    if (command === "foreColor" && value) {
      applyEditorDefaultStyle(editor, { color: value });
      return;
    }
    if (command === "fontName" && value) {
      applyEditorDefaultStyle(editor, { fontFamily: value });
      return;
    }
  }
  // styleWithCSS makes execCommand emit inline style attrs instead of legacy
  // <font> tags — that gives us proper CSS we can serialize back into the
  // sidecar without surprises.
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(command, false, value);
  // Update savedRange to the result so subsequent commands stack on the
  // same selection instead of resetting back to the pre-command range.
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
};

const applyCommand = (command: string, value?: string) => {
  const editor = getActiveEditor();
  if (editor) {
    runCommandOnEditor(editor, command, value);
    return;
  }
  // No active editor: try promoting the selected text annotation into edit
  // mode, then defer the command until the new contenteditable is mounted
  // and focusable. rAF is enough — Solid commits the DOM change before the
  // next paint.
  if (!tryEnterEditMode()) return;
  requestAnimationFrame(() => {
    const e = getActiveEditor();
    if (!e) return;
    e.focus();
    selectAllInEditor(e);
    runCommandOnEditor(e, command, value);
  });
};

export const toggleBold = () => applyCommand("bold");
export const toggleItalic = () => applyCommand("italic");
export const toggleUnderline = () => applyCommand("underline");
export const alignLeft = () => applyCommand("justifyLeft");
export const alignCenter = () => applyCommand("justifyCenter");
export const alignRight = () => applyCommand("justifyRight");

export const setFontFamily = (font: string) => applyCommand("fontName", font);

const wrapSelectionWithFontSize = (editor: HTMLElement, px: number) => {
  restoreSelectionInto(editor);
  const range = currentRangeInEditor(editor);
  if (!range || range.collapsed) {
    applyEditorDefaultStyle(editor, { fontSize: px });
    return;
  }
  const sel = window.getSelection();
  if (!sel) return;
  const span = document.createElement("span");
  span.style.fontSize = `${px * editorZoom(editor)}px`;
  try {
    range.surroundContents(span);
  } catch {
    const contents = range.extractContents();
    span.appendChild(contents);
    range.insertNode(span);
  }
  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.removeAllRanges();
  sel.addRange(newRange);
  savedRange = newRange.cloneRange();
};

/**
 * Apply an arbitrary pixel font-size. Prefers the active selection; if no
 * editor is focused, promotes the selected text annotation into edit mode,
 * then applies the new size to its full contents.
 */
export const setFontSizePx = (px: number) => {
  const editor = getActiveEditor();
  if (editor) {
    wrapSelectionWithFontSize(editor, px);
    return;
  }
  if (!tryEnterEditMode()) return;
  requestAnimationFrame(() => {
    const e = getActiveEditor();
    if (!e) return;
    e.focus();
    selectAllInEditor(e);
    wrapSelectionWithFontSize(e, px);
  });
};

export const setFontColor = (color: string) => applyCommand("foreColor", color);

export interface TextFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: "left" | "center" | "right" | "justify" | null;
  fontFamily: string | null;
  fontSizePx: number | null;
}

export const queryTextFormatState = (): TextFormatState | null => {
  const editor = getActiveEditor();
  if (!editor) return null;
  const align = (() => {
    if (document.queryCommandState("justifyCenter")) return "center" as const;
    if (document.queryCommandState("justifyRight")) return "right" as const;
    if (document.queryCommandState("justifyLeft")) return "left" as const;
    return null;
  })();
  let fontFamily: string | null = null;
  let fontSizePx: number | null = null;
  try {
    const fam = document.queryCommandValue("fontName");
    if (fam) fontFamily = fam.replace(/^['"]+|['"]+$/g, "");
  } catch { /* ignore */ }
  try {
    // Read the computed style of the focus node's parent element for an
    // accurate px reading (queryCommandValue("fontSize") returns 1–7).
    const sel = window.getSelection();
    const node =
      sel?.focusNode?.nodeType === Node.ELEMENT_NODE
        ? (sel.focusNode as HTMLElement)
        : sel?.focusNode?.parentElement ?? null;
    if (node) {
      const sz = window.getComputedStyle(node).fontSize;
      const m = /^(\d+(?:\.\d+)?)px$/.exec(sz);
      if (m) fontSizePx = Math.round(parseFloat(m[1]));
    }
  } catch { /* ignore */ }
  return {
    bold: document.queryCommandState("bold"),
    italic: document.queryCommandState("italic"),
    underline: document.queryCommandState("underline"),
    align,
    fontFamily,
    fontSizePx,
  };
};

export const COMMON_FONTS = [
  "Pretendard Variable",
  "system-ui",
  "Helvetica",
  "Arial",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "ui-monospace",
];
