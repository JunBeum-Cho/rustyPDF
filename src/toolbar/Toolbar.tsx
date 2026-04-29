import { Show } from "solid-js";
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Minus,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  RotateCw,
  Sun,
} from "lucide-solid";
import { documentStore, setDocumentStore } from "../state/document";
import { applyTheme, setUiStore, uiStore } from "../state/ui";
import { requestOpenPdfDialog } from "../ipc/pdf";
import { AnnotationToolbar } from "../annotations/AnnotationToolbar";
import "./toolbar.css";

function cycleTheme() {
  const next =
    uiStore.theme === "auto"
      ? "dark"
      : uiStore.theme === "dark"
        ? "light"
        : "auto";
  setUiStore("theme", next);
  applyTheme(next);
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function zoomIn() {
  const next = ZOOM_STEPS.find((z) => z > documentStore.zoom);
  if (next) setDocumentStore("zoom", next);
}

function zoomOut() {
  const prev = [...ZOOM_STEPS].reverse().find((z) => z < documentStore.zoom);
  if (prev) setDocumentStore("zoom", prev);
}

function rotateRight() {
  const r = ((documentStore.rotation + 90) % 360) as 0 | 90 | 180 | 270;
  setDocumentStore("rotation", r);
}

const ICON_SIZE = 16;

function ThemeIcon() {
  if (uiStore.theme === "dark") return <Moon size={ICON_SIZE} />;
  if (uiStore.theme === "light") return <Sun size={ICON_SIZE} />;
  return <Monitor size={ICON_SIZE} />;
}

export function Toolbar() {
  return (
    <header class="toolbar">
      <div class="toolbar-group">
        <button
          class="toolbar-btn"
          onClick={requestOpenPdfDialog}
          title="PDF 열기 (Ctrl+O)"
        >
          <FolderOpen size={ICON_SIZE} />
          <span>열기</span>
        </button>
      </div>

      <Show when={documentStore.doc}>
        <div class="toolbar-group">
          <button
            class="toolbar-btn icon-only"
            onClick={() => setUiStore("sidebarOpen", (open) => !open)}
            title="썸네일 (Ctrl+\\)"
            classList={{ active: uiStore.sidebarOpen }}
          >
            <PanelLeft size={ICON_SIZE} />
          </button>
        </div>
      </Show>

      <div class="toolbar-spacer" />
      <div class="toolbar-group">
        <button
          class="toolbar-btn icon-only"
          onClick={cycleTheme}
          title={`테마: ${uiStore.theme}`}
        >
          <ThemeIcon />
        </button>
      </div>

      <Show when={documentStore.doc}>
        <div class="toolbar-group">
          <button
            class="toolbar-btn icon-only"
            disabled={documentStore.currentPage <= 0}
            onClick={() =>
              setDocumentStore("currentPage", (p) => Math.max(0, p - 1))
            }
            title="이전 페이지"
          >
            <ChevronLeft size={ICON_SIZE} />
          </button>
          <span class="page-indicator">
            {documentStore.currentPage + 1} / {documentStore.doc!.pageCount}
          </span>
          <button
            class="toolbar-btn icon-only"
            disabled={
              documentStore.currentPage >= documentStore.doc!.pageCount - 1
            }
            onClick={() =>
              setDocumentStore("currentPage", (p) =>
                Math.min(documentStore.doc!.pageCount - 1, p + 1)
              )
            }
            title="다음 페이지"
          >
            <ChevronRight size={ICON_SIZE} />
          </button>
        </div>

        <div class="toolbar-group">
          <button class="toolbar-btn icon-only" onClick={zoomOut} title="축소">
            <Minus size={ICON_SIZE} />
          </button>
          <span class="zoom-indicator">
            {Math.round(documentStore.zoom * 100)}%
          </span>
          <button class="toolbar-btn icon-only" onClick={zoomIn} title="확대">
            <Plus size={ICON_SIZE} />
          </button>
          <button
            class="toolbar-btn icon-only"
            onClick={rotateRight}
            title="회전 (R)"
          >
            <RotateCw size={ICON_SIZE} />
          </button>
        </div>

        <AnnotationToolbar />
      </Show>
    </header>
  );
}
