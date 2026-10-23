export function shortcutLabel(key: string, shift = false, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /Mac|iPhone|iPad/.test(platform) ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}
export function blocksToolShortcut(tag: string, editable: boolean, role: string | null): boolean {
  return editable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(tag) || ['button', 'tab', 'textbox', 'combobox', 'slider', 'menuitem'].includes(role ?? '');
}

export type Tool = "select" | "text" | "highlight" | "pen";

export type Shortcut =
  | { type: "tool"; tool: Tool }
  | { type: "rotate"; direction: 1 | -1 }
  | { type: "zoomIn" }
  | { type: "zoomOut" }
  | { type: "zoomReset" }
  | { type: "open" }
  | { type: "search" }
  | { type: "close" }
  | { type: "save"; asNew: boolean }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "print" }
  | { type: "help" }
  | { type: "sidebar" }
  | { type: "cycleTab"; direction: 1 | -1 }
  | { type: "deleteAnnotations" }
  | { type: "page"; delta: number }
  | { type: "pageSpace" }
  | { type: "pageHome" }
  | { type: "pageEnd" };

export interface KeyEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

const TOOL_CODES: Record<string, Tool> = { KeyV: "select", KeyT: "text", KeyH: "highlight", KeyP: "pen" };

/** Pure key -> action mapping. Uses e.code so Korean IME layouts work (§2.11). */
export function shortcutFor(e: KeyEventLike): Shortcut | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (mod) {
    switch (e.code) {
      case "Equal":
      case "NumpadAdd": return { type: "zoomIn" };
      case "Minus":
      case "NumpadSubtract": return { type: "zoomOut" };
      case "Digit0":
      case "Numpad0": return { type: "zoomReset" };
      case "KeyO": return { type: "open" };
      case "KeyF": return { type: "search" };
      case "KeyW": return { type: "close" };
      case "KeyS": return { type: "save", asNew: e.shiftKey };
      case "KeyZ": return e.shiftKey ? { type: "redo" } : { type: "undo" };
      case "KeyY": return { type: "redo" };
      case "KeyP": return { type: "print" };
      case "Slash": return { type: "help" };
      case "Backslash": return { type: "sidebar" };
      case "Tab": return { type: "cycleTab", direction: e.shiftKey ? -1 : 1 };
    }
    return null;
  }
  if (e.altKey) return null;
  if (e.code === "Slash" && e.shiftKey) return { type: "help" };
  const tool = TOOL_CODES[e.code];
  if (tool && !e.shiftKey) return { type: "tool", tool };
  switch (e.code) {
    case "KeyR": return { type: "rotate", direction: e.shiftKey ? -1 : 1 };
    case "Backspace":
    case "Delete": return { type: "deleteAnnotations" };
    case "ArrowLeft":
    case "PageUp": return { type: "page", delta: -1 };
    case "ArrowRight":
    case "PageDown": return { type: "page", delta: 1 };
    case "Space": return { type: "pageSpace" };
    case "Home": return { type: "pageHome" };
    case "End": return { type: "pageEnd" };
  }
  return null;
}
