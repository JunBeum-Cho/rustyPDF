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
  Save,
  Sun,
} from "lucide-solid";
import { activeTab, updateActiveTab } from "../state/document";
import { applyTheme, setUiStore, uiStore } from "../state/ui";
import { requestOpenPdfDialog, saveActivePdf } from "../ipc/pdf";
import { AnnotationToolbar } from "../annotations/AnnotationToolbar";
import { OcrButton } from "../ocr/OcrButton";
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
  const tab = activeTab();
  if (!tab) return;
  const next = ZOOM_STEPS.find((z) => z > tab.zoom);
  if (next) updateActiveTab((t) => { t.zoom = next; });
}

function zoomOut() {
  const tab = activeTab();
  if (!tab) return;
  const prev = [...ZOOM_STEPS].reverse().find((z) => z < tab.zoom);
  if (prev) updateActiveTab((t) => { t.zoom = prev; });
}

function rotateRight() {
  const tab = activeTab();
  if (!tab) return;
  const r = ((tab.rotation + 90) % 360) as 0 | 90 | 180 | 270;
  updateActiveTab((t) => { t.rotation = r; });
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

      <Show when={activeTab()}>
        {(tab) => (
          <div class="toolbar-group">
            <button
              class="toolbar-btn icon-only"
              onClick={() => setUiStore("sidebarOpen", (open) => !open)}
              title="썸네일 (Ctrl+\\)"
              classList={{ active: uiStore.sidebarOpen }}
            >
              <PanelLeft size={ICON_SIZE} />
            </button>
            <button
              class="toolbar-btn icon-only"
              classList={{ "save-dirty": tab().pageDirty }}
              onClick={(event) => void saveActivePdf(event.shiftKey)}
              title={
                tab().pageDirty
                  ? "변경사항 저장 (Cmd+S, Shift+클릭=다른 이름)"
                  : "다른 이름으로 저장 (Cmd+Shift+S)"
              }
            >
              <Save size={ICON_SIZE} />
            </button>
          </div>
        )}
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

      <Show when={activeTab()}>
        {(tab) => (
          <>
            <div class="toolbar-group">
              <button
                class="toolbar-btn icon-only"
                disabled={tab().currentPage <= 0}
                onClick={() =>
                  updateActiveTab((t) => {
                    t.currentPage = Math.max(0, t.currentPage - 1);
                  })
                }
                title="이전 페이지"
              >
                <ChevronLeft size={ICON_SIZE} />
              </button>
              <span class="page-indicator">
                {tab().currentPage + 1} / {tab().pageCount}
              </span>
              <button
                class="toolbar-btn icon-only"
                disabled={tab().currentPage >= tab().pageCount - 1}
                onClick={() =>
                  updateActiveTab((t) => {
                    t.currentPage = Math.min(
                      t.pageCount - 1,
                      t.currentPage + 1,
                    );
                  })
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
                {Math.round(tab().zoom * 100)}%
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
            <OcrButton />
          </>
        )}
      </Show>
    </header>
  );
}
