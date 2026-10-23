import { onCleanup, onMount } from "solid-js";
import {
  activeTab,
  documentStore,
  setActiveTab,
  updateActiveTab,
} from "./state/document";
import { applyTheme, setUiStore, uiStore } from "./state/ui";
import { closeTab, openPdfDialog, saveActivePdf } from "./ipc/pdf";
import {
  deleteSelectedAnnotations,
  setAnnotationTool,
} from "./annotations/store";
import { rotateSelectedPages } from "./viewer/pageRotation";
import { undoDocumentEdit, redoDocumentEdit } from "./viewer/documentHistory";
import { setManualZoom, setNavigationMode, zoomIn, zoomOut } from "./viewer/navigation";
import { printActiveDocument } from "./print/print";
import { blocksToolShortcut } from "./platform/shortcuts";
import { toggleShortcutHelp } from "./help/ShortcutHelp";

import { shortcutFor, type Shortcut } from "./platform/shortcuts";
export { shortcutFor };
export type { Shortcut };

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
}

function isAnnotationToolbarTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && Boolean(t.closest(".annotation-toolbar"));
}

function isInteractiveTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    Boolean(t.closest("button, a, select, [role='button']"))
  );
}

function gotoPage(delta: number) {
  const tab = activeTab();
  if (!tab) return;
  const max = tab.pageCount - 1;
  updateActiveTab((t) => {
    t.navigationVersion = (t.navigationVersion ?? 0) + 1;
    t.currentPage = Math.max(0, Math.min(max, t.currentPage + delta));
  });
}

function cycleTab(direction: 1 | -1) {
  const tabs = documentStore.tabs;
  if (tabs.length === 0) return;
  const idx = tabs.findIndex((t) => t.tabId === documentStore.activeTabId);
  const next = (idx + direction + tabs.length) % tabs.length;
  setActiveTab(tabs[next].tabId);
}

export function installKeyboardShortcuts() {
  onMount(() => {
    applyTheme(uiStore.theme);

    const onKey = (e: KeyboardEvent) => {
      // Sidebar page shortcuts (T10) run in the capture phase and mark the
      // event handled; Delete there must not also delete annotations.
      if (e.defaultPrevented) return;
      const action = shortcutFor(e);
      if (!action) return;
      if (
        action.type === "deleteAnnotations" &&
        e.target instanceof HTMLElement &&
        e.target.closest(".thumbnail-sidebar")
      ) {
        return;
      }
      const tab = activeTab();
      const editable = isEditableTarget(e.target);

      // Save, undo/redo in the annotation toolbar and help work from editors.
      if (editable) {
        const allowed =
          action.type === "save" ||
          action.type === "help" && (e.metaKey || e.ctrlKey) ||
          ((action.type === "undo" || action.type === "redo") && isAnnotationToolbarTarget(e.target));
        if (!allowed) return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        const target = e.target instanceof HTMLElement ? e.target : null;
        if (
          target &&
          action.type !== "help" &&
          (blocksToolShortcut(target.tagName, target.isContentEditable, target.getAttribute("role")) ||
            target.closest("button, a, select, [role=button], [role=tab]"))
        ) {
          return;
        }
      }

      switch (action.type) {
        case "tool": setAnnotationTool(action.tool); break;
        case "rotate": if (tab && !tab.readOnly) void rotateSelectedPages(action.direction); break;
        case "zoomIn": zoomIn(); break;
        case "zoomOut": zoomOut(); break;
        case "zoomReset": setNavigationMode("manual"); setManualZoom(1); break;
        case "open": void openPdfDialog(); break;
        case "search": setUiStore("searchOpen", (v) => !v); break;
        case "close": if (tab) void closeTab(tab.tabId); break;
        case "save": if (tab) void saveActivePdf(action.asNew); break;
        case "undo": void undoDocumentEdit(); break;
        case "redo": void redoDocumentEdit(); break;
        case "print": if (tab) void printActiveDocument(); break;
        case "help": toggleShortcutHelp(); break;
        case "sidebar": setUiStore("sidebarOpen", (v) => !v); break;
        case "cycleTab": cycleTab(action.direction); break;
        case "deleteAnnotations": deleteSelectedAnnotations(); break;
        case "page": gotoPage(action.delta); break;
        case "pageSpace":
          // Space on a focused button is the native "activate" key.
          if (isInteractiveTarget(e.target)) return;
          gotoPage(1);
          break;
        case "pageHome": gotoPage(-Infinity); break;
        case "pageEnd": gotoPage(Infinity); break;
      }
      e.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
}
