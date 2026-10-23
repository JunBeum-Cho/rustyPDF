import { Show, createSignal, onCleanup, onMount } from "solid-js";
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
  SaveAll,
  MoveHorizontal,
  Maximize,
  Search,
  Printer,
  List,
  Contrast,
  Sun,
} from "lucide-solid";
import { activeTab, updateActiveTab } from "../state/document";
import { applyTheme, setUiStore, uiStore } from "../state/ui";
import { openPdfDialog, saveActivePdf } from "../ipc/pdf";
import { printActiveDocument } from "../print/print";
import { OcrButton } from "../ocr/OcrButton";
import { AnnotationToolbar } from "../annotations/AnnotationToolbar";
import { rotateSelectedPages } from "../viewer/pageRotation";
import "./toolbar.css";
import { shortcutLabel } from "../platform/shortcuts";
import { navigateToPage, navigationMode, parsePageEntry, parseZoomEntry, setManualZoom, setNavigationMode, zoomIn, zoomOut } from "../viewer/navigation";

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

const ICON_SIZE = 16;

function ThemeIcon() {
  if (uiStore.theme === "dark") return <Moon size={ICON_SIZE} />;
  if (uiStore.theme === "light") return <Sun size={ICON_SIZE} />;
  return <Monitor size={ICON_SIZE} />;
}

function useSystemDark() {
  const mq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
  const [dark, setDark] = createSignal(mq?.matches ?? false);
  onMount(() => {
    const h = (e: MediaQueryListEvent) => setDark(e.matches);
    mq?.addEventListener?.("change", h);
    onCleanup(() => mq?.removeEventListener?.("change", h));
  });
  return dark;
}

export function Toolbar() {
  const systemDark = useSystemDark();
  const effectiveDark = () => uiStore.theme === "dark" || (uiStore.theme === "auto" && systemDark());
  return (
    <header class="toolbar">
      <div class="toolbar-group">
        <button
          class="toolbar-btn"
          onClick={() => void openPdfDialog()}
          title={`PDF 열기 (${shortcutLabel("O")})`}
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
              onClick={() => { const close = uiStore.sidebarOpen && uiStore.sidebarMode === "thumbnails"; setUiStore("sidebarMode", "thumbnails"); setUiStore("sidebarOpen", !close); }}
              title={`썸네일 (${shortcutLabel("\\")})`}
              classList={{ active: uiStore.sidebarOpen && uiStore.sidebarMode === "thumbnails" }}
            >
              <PanelLeft size={ICON_SIZE} />
            </button>
            <button
              class="toolbar-btn icon-only"
              onClick={() => { setUiStore("sidebarMode", "outline"); setUiStore("sidebarOpen", true); }}
              aria-label="목차"
              aria-pressed={uiStore.sidebarOpen && uiStore.sidebarMode === "outline"}
              title="목차"
              classList={{ active: uiStore.sidebarOpen && uiStore.sidebarMode === "outline" }}
            >
              <List size={ICON_SIZE} />
            </button>
            <button
              class="toolbar-btn icon-only"
              classList={{
                "save-dirty": tab().pageDirty || tab().formDirty || tab().annotations.dirty,
              }}
              disabled={tab().readOnly}
              onClick={(event) => void saveActivePdf(event.shiftKey)}
              title={`저장 — 다음에도 주석을 편집할 수 있습니다 (${shortcutLabel("S")})`}
              aria-label="저장"
            >
              <Save size={ICON_SIZE} />
            </button>
            <button class="toolbar-btn icon-only" disabled={tab().readOnly} onClick={() => void saveActivePdf(true)} aria-label="다른 이름으로 저장" title={`다른 이름으로 저장 (${shortcutLabel("S", true)})`}><SaveAll size={ICON_SIZE} /></button>
            <button class="toolbar-btn icon-only" onClick={() => void printActiveDocument()} aria-label="인쇄" title={`인쇄 (${shortcutLabel("P")})`}><Printer size={ICON_SIZE} /></button>
            <Show when={tab().readOnly}><span class="readonly-badge" title="이 문서는 읽기 전용입니다">읽기 전용</span></Show>
            <button class="toolbar-btn icon-only" onClick={() => setUiStore("searchOpen", v => !v)} aria-label="문서 검색" aria-pressed={uiStore.searchOpen} title={`검색 (${shortcutLabel("F")})`}><Search size={ICON_SIZE} /></button>
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
        <Show when={effectiveDark()}>
          <button
            class="toolbar-btn icon-only"
            aria-label="페이지 색 반전"
            aria-pressed={uiStore.invertPagesInDark}
            classList={{ active: uiStore.invertPagesInDark }}
            onClick={() => setUiStore("invertPagesInDark", (v) => !v)}
            title="어두운 테마에서 페이지 색 반전"
          >
            <Contrast size={ICON_SIZE} />
          </button>
        </Show>
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
                    t.navigationVersion = (t.navigationVersion ?? 0) + 1;
                    t.currentPage = Math.max(0, t.currentPage - 1);
                  })
                }
                title="이전 페이지"
              >
                <ChevronLeft size={ICON_SIZE} />
              </button>
              <label class="page-indicator">
                <input class="navigation-input" aria-label="페이지 번호" inputmode="numeric" value={tab().currentPage + 1}
                  onChange={event => { const page = parsePageEntry(event.currentTarget.value, tab().pageCount); if (page !== null) navigateToPage(page); event.currentTarget.value = String((page ?? tab().currentPage) + 1); }}
                  onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /> / {tab().pageCount}
              </label>
              <button
                class="toolbar-btn icon-only"
                disabled={tab().currentPage >= tab().pageCount - 1}
                onClick={() =>
                  updateActiveTab((t) => {
                    t.navigationVersion = (t.navigationVersion ?? 0) + 1;
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
              <button
                class="toolbar-btn icon-only"
                onClick={zoomOut}
                title="축소"
              >
                <Minus size={ICON_SIZE} />
              </button>
              <input class="navigation-input zoom-entry" aria-label="확대 비율 (%)" inputmode="decimal" value={`${Math.round(tab().zoom * 100)}%`}
                onChange={event => { const zoom = parseZoomEntry(event.currentTarget.value); if (zoom !== null) setManualZoom(zoom); event.currentTarget.value = `${Math.round(tab().zoom * 100)}%`; }}
                onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              <button
                class="toolbar-btn icon-only"
                onClick={zoomIn}
                title="확대"
              >
                <Plus size={ICON_SIZE} />
              </button>
              <button class="toolbar-btn icon-only" aria-pressed={navigationMode() === "width"} onClick={() => setNavigationMode("width")} aria-label="너비 맞춤" title="너비 맞춤"><MoveHorizontal size={ICON_SIZE} /></button>
              <button class="toolbar-btn icon-only" aria-pressed={navigationMode() === "page"} onClick={() => setNavigationMode("page")} aria-label="페이지 맞춤" title="페이지 맞춤"><Maximize size={ICON_SIZE} /></button>
              <button
                class="toolbar-btn icon-only"
                disabled={tab().readOnly}
                onClick={() => void rotateSelectedPages(1)}
                title="선택 페이지 회전 (R)"
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
