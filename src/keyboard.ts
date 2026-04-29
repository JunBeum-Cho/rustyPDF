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
  redoAnnotations,
  undoAnnotations,
} from "./annotations/store";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
}

function isAnnotationToolbarTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && Boolean(t.closest(".annotation-toolbar"));
}

function handleUndoRedo(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return false;
  if (e.key === "z" || e.key === "Z") {
    e.preventDefault();
    if (e.shiftKey) redoAnnotations();
    else undoAnnotations();
    return true;
  }
  if (e.key === "y" || e.key === "Y") {
    e.preventDefault();
    redoAnnotations();
    return true;
  }
  return false;
}

function nextZoom() {
  const tab = activeTab();
  if (!tab) return;
  const next = ZOOM_STEPS.find((z) => z > tab.zoom);
  if (next) updateActiveTab((t) => { t.zoom = next; });
}

function prevZoom() {
  const tab = activeTab();
  if (!tab) return;
  const prev = [...ZOOM_STEPS].reverse().find((z) => z < tab.zoom);
  if (prev) updateActiveTab((t) => { t.zoom = prev; });
}

function rotate(direction: 1 | -1) {
  const tab = activeTab();
  if (!tab) return;
  const r = ((tab.rotation + direction * 90 + 360) % 360) as
    | 0
    | 90
    | 180
    | 270;
  updateActiveTab((t) => { t.rotation = r; });
}

function gotoPage(delta: number) {
  const tab = activeTab();
  if (!tab) return;
  const max = tab.pageCount - 1;
  updateActiveTab((t) => {
    t.currentPage = Math.max(0, Math.min(max, t.currentPage + delta));
  });
}

function toggleTheme() {
  const next =
    uiStore.theme === "auto"
      ? "dark"
      : uiStore.theme === "dark"
        ? "light"
        : "auto";
  setUiStore("theme", next);
  applyTheme(next);
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
      if (isEditableTarget(e.target)) {
        if (isAnnotationToolbarTarget(e.target) && handleUndoRedo(e)) return;
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
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
        updateActiveTab((t) => { t.zoom = 1; });
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
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (tab) void saveActivePdf(e.shiftKey);
        return;
      }
      if (mod && e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (handleUndoRedo(e)) return;

      if (!mod) {
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
          case " ":
            e.preventDefault();
            gotoPage(1);
            break;
          case "r":
            e.preventDefault();
            rotate(e.shiftKey ? -1 : 1);
            break;
          case "t":
            e.preventDefault();
            toggleTheme();
            break;
          case "Home":
            e.preventDefault();
            updateActiveTab((t) => { t.currentPage = 0; });
            break;
          case "End":
            e.preventDefault();
            if (tab) {
              updateActiveTab((t) => { t.currentPage = t.pageCount - 1; });
            }
            break;
        }
      }
    };

    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
}
