import { normalizeFontFamily } from "./fonts";
export { COMMON_FONTS } from "./fonts";
/**
 * Rich-text formatting helpers for the contenteditable text annotation editor.
 *
 * The work is split in two:
 *  - Colour, font size and font family go through `applyInlineStyle`, a small
 *    Range-based engine that splits the boundary text nodes and wraps only
 *    the selected text in `<span style>`. execCommand's foreColor / fontSize /
 *    fontName rewrite surrounding markup unpredictably (legacy <font> tags,
 *    size 1-7, whole-block restyles), which made the saved HTML untidy.
 *  - Bold / italic / underline / alignment still use `document.execCommand`
 *    through the single `runFormatCommand` helper: it is deprecated but every
 *    engine implements it, and it keeps the native undo stack for toggles.
 *
 * Buttons that drive these helpers MUST call `event.preventDefault()` on
 * mousedown — otherwise the browser moves focus to the button and the
 * editor's selection collapses, leaving the helpers with nothing to act on.
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

/**
 * Returns the most recently focused editor if it's still attached. Lets
 * callers outside this module (e.g. the layer's "click empty space" path)
 * find the live editor when the user soft-blurred to a toolbar control and
 * then dismissed editing without ever refocusing the contenteditable.
 */
export const peekLastFocusedEditor = (): HTMLElement | null => {
  if (lastFocusedEditor && !lastFocusedEditor.isConnected) {
    lastFocusedEditor = null;
  }
  return lastFocusedEditor;
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
  // Drop a detached cached ref. Edit mode can end without an explicit blur
  // (tab switch, programmatic stopEditingAnnotation, doc reload), and
  // returning a node that's no longer in the document would mislead callers
  // into the in-editor styling path with no observable effect.
  if (lastFocusedEditor && !lastFocusedEditor.isConnected) {
    lastFocusedEditor = null;
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
    editor.style.fontFamily = normalizeFontFamily(patch.fontFamily);
    editor.dataset.annotationFontFamily = normalizeFontFamily(patch.fontFamily);
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

/**
 * Wrap only the selected text of `range` in `<span style>`. Boundary text
 * nodes are split first; a span that already covers exactly the same text is
 * reused, and the same property is removed from elements fully inside the
 * range so nested spans never fight. A collapsed range is a no-op.
 * Returns the range covering the styled text, or null when nothing changed.
 */
export function applyInlineStyle(range: Range, style: TextStylePatch): Range | null {
  if (range.collapsed) return null;
  const props: [string, string][] = [];
  if (style.color !== undefined) props.push(["color", style.color]);
  if (style.fontSize !== undefined) props.push(["font-size", `${style.fontSize}px`]);
  if (style.fontFamily !== undefined) props.push(["font-family", normalizeFontFamily(style.fontFamily)]);
  if (props.length === 0) return null;
  const doc = range.commonAncestorContainer.ownerDocument ?? document;

  // Split the end first so the start offset stays valid when both are in one node.
  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    const t = range.endContainer as Text;
    if (range.endOffset > 0 && range.endOffset < t.length) t.splitText(range.endOffset);
  }
  let startNode = range.startContainer;
  if (startNode.nodeType === Node.TEXT_NODE) {
    const t = startNode as Text;
    if (range.startOffset >= t.length) {
      // Nothing selected in this node; the walk below starts after it.
    } else if (range.startOffset > 0) {
      const tail = t.splitText(range.startOffset);
      if (range.endContainer === t) range.setEnd(tail, range.endOffset - range.startOffset);
      range.setStart(tail, 0);
      startNode = tail;
    }
  }

  const root = range.commonAncestorContainer;
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(
    root.nodeType === Node.TEXT_NODE ? (root.parentNode as Node) : root,
    NodeFilter.SHOW_TEXT,
  );
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.length === 0 || !range.intersectsNode(t)) continue;
    const from = t === range.startContainer ? range.startOffset : 0;
    const to = t === range.endContainer ? range.endOffset : t.length;
    if (to > from) texts.push(t);
  }
  if (texts.length === 0) return null;

  // Strip the property from elements wholly inside the selection.
  const scope = (root.nodeType === Node.TEXT_NODE ? root.parentElement : root) as Element | null;
  const inside = (el: Element) => {
    const r = doc.createRange();
    r.selectNode(el);
    return range.compareBoundaryPoints(Range.START_TO_START, r) <= 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, r) >= 0;
  };
  if (scope) {
    const els = [...scope.querySelectorAll<HTMLElement>("[style], font")];
    for (const el of els) {
      if (!inside(el)) continue;
      for (const [prop] of props) el.style.removeProperty(prop);
      if (el.tagName === "FONT") {
        if (style.color !== undefined) el.removeAttribute("color");
        if (style.fontFamily !== undefined) el.removeAttribute("face");
        if (style.fontSize !== undefined) el.removeAttribute("size");
      }
      if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
    }
  }

  const styled: Text[] = [];
  for (const t of texts) {
    let span: HTMLElement;
    const parent = t.parentElement;
    if (
      parent && parent.tagName === "SPAN" && parent.childNodes.length === 1 &&
      !parent.classList.contains("annotation-text-edit")
    ) {
      span = parent;
    } else {
      span = doc.createElement("span");
      t.parentNode!.insertBefore(span, t);
      span.appendChild(t);
    }
    for (const [prop, value] of props) span.style.setProperty(prop, value);
    styled.push(t);
  }
  const out = doc.createRange();
  out.setStart(styled[0], 0);
  out.setEnd(styled[styled.length - 1], styled[styled.length - 1].length);
  return out;
}

/** The one place execCommand is called (bold / italic / underline / align). */
function runFormatCommand(editor: HTMLElement, command: string) {
  // styleWithCSS makes execCommand emit inline style attrs instead of legacy
  // <font> tags — proper CSS we can serialize into the sidecar.
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(command, false);
  if (command === "italic") {
    // Chromium emits inline `italic` with its default synthesis angle. Keep
    // the live selection/caret while matching the export's 12-degree shear.
    for (const element of [editor, ...editor.querySelectorAll<HTMLElement>("[style]")]) {
      if (element.style.fontStyle === "italic") element.style.fontStyle = "oblique 12deg";
    }
  }
}

const saveCurrentRange = () => {
  // Update savedRange so subsequent commands stack on the same selection.
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange();
};

const runCommandOnEditor = (editor: HTMLElement, command: string) => {
  restoreSelectionInto(editor);
  runFormatCommand(editor, command);
  saveCurrentRange();
};

/** Colour / size / font: styles the selection, or the editor default when collapsed. */
const styleEditor = (editor: HTMLElement, patch: TextStylePatch) => {
  restoreSelectionInto(editor);
  const range = currentRangeInEditor(editor);
  if (!range || range.collapsed) {
    applyEditorDefaultStyle(editor, patch);
    return;
  }
  const scaled = patch.fontSize === undefined
    ? patch
    : { ...patch, fontSize: patch.fontSize * editorZoom(editor) };
  const out = applyInlineStyle(range, scaled);
  if (!out) return;
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(out);
  }
  savedRange = out.cloneRange();
};

const applyEditorAction = (action: (editor: HTMLElement) => void) => {
  const editor = getActiveEditor();
  if (editor) {
    action(editor);
    return;
  }
  // No active editor: try promoting the selected text annotation into edit
  // mode, then defer the action until the new contenteditable is mounted
  // and focusable. rAF is enough — Solid commits the DOM change before the
  // next paint.
  if (!tryEnterEditMode()) return;
  requestAnimationFrame(() => {
    const e = getActiveEditor();
    if (!e) return;
    e.focus();
    selectAllInEditor(e);
    action(e);
  });
};

const applyCommand = (command: string) =>
  applyEditorAction((editor) => runCommandOnEditor(editor, command));

export const toggleBold = () => applyCommand("bold");
export const toggleItalic = () => applyCommand("italic");
export const toggleUnderline = () => applyCommand("underline");
export const alignLeft = () => applyCommand("justifyLeft");
export const alignCenter = () => applyCommand("justifyCenter");
export const alignRight = () => applyCommand("justifyRight");

export const setFontFamily = (font: string) =>
  applyEditorAction((editor) => styleEditor(editor, { fontFamily: normalizeFontFamily(font) }));

/**
 * Apply an arbitrary pixel font-size. Prefers the active selection; if no
 * editor is focused, promotes the selected text annotation into edit mode,
 * then applies the new size to its full contents.
 */
export const setFontSizePx = (px: number) =>
  applyEditorAction((editor) => styleEditor(editor, { fontSize: px }));

export const setFontColor = (color: string) =>
  applyEditorAction((editor) => styleEditor(editor, { color }));

/** `rgb(r, g, b)` / `rgba(...)` computed colour to `#rrggbb`; black if unparsable. */
export const cssColorToHex = (value: string): string => {
  const match = value.match(/-?\d+(\.\d+)?/g);
  if (!match || match.length < 3) return "#000000";
  const channel = (raw: string) => {
    const n = Math.round(Number(raw));
    const clamped = Math.min(255, Math.max(0, Number.isFinite(n) ? n : 0));
    return clamped.toString(16).padStart(2, "0");
  };
  return `#${channel(match[0])}${channel(match[1])}${channel(match[2])}`;
};

/** Computed font-style that counts as italic (we render italic as oblique 12deg). */
export const isItalicStyle = (fontStyle: string): boolean =>
  fontStyle === "italic" || fontStyle.startsWith("oblique");

/** The shared value when every entry agrees, otherwise null. */
export const sameValueOrNull = <T,>(values: T[]): T | null => {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
};

export interface TextFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: "left" | "center" | "right" | "justify" | null;
  fontFamily: string | null;
  fontSizePx: number | null;
  color: string | null;
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
  let color: string | null = null;
  let italic = document.queryCommandState("italic");
  try {
    const fam = document.queryCommandValue("fontName");
    if (fam) fontFamily = normalizeFontFamily(fam);
  } catch { /* ignore */ }
  try {
    // Read the computed style of the focus node's parent element for an
    // accurate px reading (queryCommandValue("fontSize") returns 1–7).
    const sel = window.getSelection();
    const node =
      sel?.focusNode?.nodeType === Node.ELEMENT_NODE
        ? (sel.focusNode as HTMLElement)
        : sel?.focusNode?.parentElement ?? null;
    if (node && editor.contains(node)) {
      const computed = window.getComputedStyle(node);
      italic = isItalicStyle(computed.fontStyle);
      const sz = computed.fontSize;
      const m = /^(\d+(?:\.\d+)?)px$/.exec(sz);
      if (m) fontSizePx = Math.round(parseFloat(m[1]) / editorZoom(editor));
      if (/^rgba?\(/.test(computed.color)) color = cssColorToHex(computed.color);
    }
  } catch { /* ignore */ }
  return {
    bold: document.queryCommandState("bold"),
    italic,
    underline: document.queryCommandState("underline"),
    align,
    fontFamily,
    fontSizePx,
    color,
  };
};
