import { onCleanup, onMount } from "solid-js";
import { documentStore, setDocumentStore } from "./state/document";
import { applyTheme, setUiStore, uiStore } from "./state/ui";
import { requestOpenPdfDialog } from "./ipc/pdf";
import {
  deleteSelectedAnnotations,
  redoAnnotations,
  undoAnnotations,
} from "./annotations/store";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    t.isContentEditable
  );
}

function nextZoom() {
  const next = ZOOM_STEPS.find((z) => z > documentStore.zoom);
  if (next) setDocumentStore("zoom", next);
}

function prevZoom() {
  const prev = [...ZOOM_STEPS].reverse().find((z) => z < documentStore.zoom);
  if (prev) setDocumentStore("zoom", prev);
}

function rotate(direction: 1 | -1) {
  const r = ((documentStore.rotation + direction * 90 + 360) % 360) as
    | 0
    | 90
    | 180
    | 270;
  setDocumentStore("rotation", r);
}

function gotoPage(delta: number) {
  if (!documentStore.doc) return;
  const max = documentStore.doc.pageCount - 1;
  setDocumentStore("currentPage", (p) =>
    Math.max(0, Math.min(max, p + delta))
  );
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

export function installKeyboardShortcuts() {
  onMount(() => {
    applyTheme(uiStore.theme);

    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;

      const mod = e.metaKey || e.ctrlKey;

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
        setDocumentStore("zoom", 1);
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
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) {
          redoAnnotations();
        } else {
          undoAnnotations();
        }
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redoAnnotations();
        return;
      }

      // unmodified
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
            setDocumentStore("currentPage", 0);
            break;
          case "End":
            e.preventDefault();
            if (documentStore.doc) {
              setDocumentStore(
                "currentPage",
                documentStore.doc.pageCount - 1
              );
            }
            break;
        }
      }
    };

    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
}
