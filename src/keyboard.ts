import { onCleanup, onMount } from "solid-js";
import {
  activeTab,
  documentStore,
  setActiveTab,
  updateActiveTab,
} from "./state/document";
import { applyTheme, setUiStore, uiStore } from "./state/ui";
import { closeTab, requestOpenPdfDialog, saveActivePdf } from "./ipc/pdf";
import {
  deleteSelectedAnnotations,
  setAnnotationTool,
} from "./annotations/store";
import { rotateDocument } from "./viewer/pageRotation";

import { undoDocumentEdit, redoDocumentEdit } from "./viewer/documentHistory";
import { setManualZoom, setNavigationMode } from "./viewer/navigation";
import { blocksToolShortcut } from "./platform/shortcuts";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

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

function handleUndoRedo(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return false;
  if (e.key === "z" || e.key === "Z") {
    e.preventDefault();
    if (e.shiftKey) void redoDocumentEdit();
    else void undoDocumentEdit();
    return true;
  }
  if (e.key === "y" || e.key === "Y") {
    e.preventDefault();
    void redoDocumentEdit();
    return true;
  }
  return false;
}

function nextZoom() {
  const tab = activeTab();
  if (!tab) return;
  setNavigationMode("manual");
  const next = ZOOM_STEPS.find((z) => z > tab.zoom);
  if (next)
    setManualZoom(next);
}

function prevZoom() {
  const tab = activeTab();
  if (!tab) return;
  setNavigationMode("manual");
  const prev = [...ZOOM_STEPS].reverse().find((z) => z < tab.zoom);
  if (prev)
    setManualZoom(prev);
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
      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+S must save even while a text annotation is being edited.
      // The contenteditable editor is an "editable target", so without this
      // the guard below would swallow the shortcut entirely. The live text
      // mirror keeps the store current, so the save captures what's on screen.
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (activeTab()) void saveActivePdf(e.shiftKey);
        return;
      }

      if (isEditableTarget(e.target)) {
        if (isAnnotationToolbarTarget(e.target) && handleUndoRedo(e)) return;
        return;
      }

      const tab = activeTab();

      if (mod && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        nextZoom();
        return;
      }
      if (mod && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        prevZoom();
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        setManualZoom(1);
        return;
      }
      if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        void requestOpenPdfDialog();
        return;
      }
      if (mod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setUiStore("searchOpen", (v) => !v);
        return;
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        setUiStore("sidebarOpen", (v) => !v);
        return;
      }
      if (mod && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        if (tab) void closeTab(tab.tabId);
        return;
      }
      if (mod && e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (handleUndoRedo(e)) return;

      if (!mod && !e.altKey) {
        const target = e.target instanceof HTMLElement ? e.target : null;
        if (target && (blocksToolShortcut(target.tagName, target.isContentEditable, target.getAttribute("role")) || target.closest("button, a, select, [role=button], [role=tab]"))) return;
        const tools = { v: "select", t: "text", h: "highlight", p: "pen" } as const;
        const tool = tools[e.key.toLowerCase() as keyof typeof tools];
        if (tool) { e.preventDefault(); setAnnotationTool(tool); return; }
        switch (e.key) {
          case "Backspace":
          case "Delete":
            e.preventDefault();
            deleteSelectedAnnotations();
            break;
          case "ArrowLeft":
          case "PageUp":
            e.preventDefault();
            gotoPage(-1);
            break;
          case "ArrowRight":
          case "PageDown":
            e.preventDefault();
            gotoPage(1);
            break;
          case " ":
            // Don't hijack Space when a button/link is focused — that's the
            // native "activate" key and stealing it breaks keyboard access.
            if (isInteractiveTarget(e.target)) break;
            e.preventDefault();
            gotoPage(1);
            break;
          case "r":
          case "R":
            e.preventDefault();
            void rotateDocument(e.shiftKey ? -1 : 1);
            break;
          case "Home":
            e.preventDefault();
            updateActiveTab((t) => {
              t.navigationVersion = (t.navigationVersion ?? 0) + 1;
              t.currentPage = 0;
            });
            break;
          case "End":
            e.preventDefault();
            if (tab) {
              updateActiveTab((t) => {
                t.navigationVersion = (t.navigationVersion ?? 0) + 1;
                t.currentPage = t.pageCount - 1;
              });
            }
            break;
        }
      }
    };

    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
}
