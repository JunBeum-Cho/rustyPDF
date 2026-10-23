import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { pdfEngine } from "../platform/pdf-engine";
import "./thumbnails.css";
import { activeTab, type PageMeta } from "../state/document";
import { clampSidebarWidth, setUiStore, uiStore } from "../state/ui";
import {
  copySelectedPages,
  cutSelectedPages,
  deleteSelectedPages,
  duplicateSelectedPages,
  extendPageSelection,
  extractSelectedPages,
  insertPdfAfter,
  moveSelectedPages,
  pageClipboard,
  pastePagesAfter,
  setSinglePageSelection,
  togglePageSelection,
} from "./pageClipboard";

import { shortcutLabel } from "../platform/shortcuts";
import { clampMenuPosition, dropSlotForPointer } from "./pageUi";
import { rotateSelectedPages } from "./pageRotation";

interface ThumbnailCanvasProps {
  page: PageMeta;
  index: number;
  docId: string;
  revision: number;
  contentVersion: number;
  /** CSS width shown right now. */
  thumbWidth: number;
  /** CSS width to render at; trails thumbWidth by 200 ms while resizing. */
  renderWidth: number;
}

const HORIZONTAL_PADDING = 32;
const MIN_THUMB_WIDTH = 80;
const RERENDER_DELAY_MS = 200;

const thumbnailHeight = (page: PageMeta, width: number) =>
  (page.height * width) / page.width;

let thumbnailObserver: IntersectionObserver | null = null;
const thumbnailVisibility = new WeakMap<Element, (visible: boolean) => void>();
function observeThumbnail(
  canvas: HTMLCanvasElement,
  handler: (visible: boolean) => void,
) {
  thumbnailObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        thumbnailVisibility.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: "480px 0px", threshold: 0 },
  );
  thumbnailVisibility.set(canvas, handler);
  thumbnailObserver.observe(canvas);
  return () => {
    thumbnailObserver?.unobserve(canvas);
    thumbnailVisibility.delete(canvas);
  };
}

function ThumbnailCanvas(props: ThumbnailCanvasProps) {
  let canvas!: HTMLCanvasElement;
  const [error, setError] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const [visible, setVisible] = createSignal(false);
  const height = createMemo(() => thumbnailHeight(props.page, props.thumbWidth));

  createEffect(() => {
    onCleanup(observeThumbnail(canvas, setVisible));
  });

  createEffect(() => {
    if (!visible()) {
      canvas.width = canvas.height = 0;
      return;
    }
    retry();
    setError(false);
    // Same docId can point at new bytes after overwrite-save.
    props.contentVersion;
    const cssWidth = props.renderWidth;
    const cssHeight = thumbnailHeight(props.page, cssWidth);
    const job = pdfEngine().renderPage(canvas, {
      docId: props.docId,
      revision: props.revision,
      pageIndex: props.index,
      cssWidth,
      cssHeight,
      dpr: window.devicePixelRatio || 1,
    });
    let cancelled = false;
    job.promise.catch((err) => {
      if (cancelled) return;
      setError(true);
      console.error("render thumbnail failed", props.index, err);
    });
    onCleanup(() => {
      cancelled = true;
      job.cancel();
    });
  });

  return (
    <div class="thumbnail-preview" onKeyDown={event => { if (error() && (event.key === "Enter" || event.key === " ")) { event.stopPropagation(); event.preventDefault(); setRetry(value => value + 1); } }}>
    <canvas
      ref={canvas}
      class="thumbnail-canvas"
      style={{ width: `${props.thumbWidth}px`, height: `${height()}px` }}
    />
    <Show when={error()}><span class="thumbnail-error" role="alert" onClick={event => { event.stopPropagation(); setRetry(value => value + 1); }}>표시 실패 · 클릭해서 재시도</span></Show>
    </div>
  );
}

interface MenuState {
  x: number;
  y: number;
  pageIndex: number;
  clamped?: boolean;
}

export function Thumbnails() {
  const tab = createMemo(() => activeTab()!);
  const sidebarWidth = createMemo(() => uiStore.sidebarWidth);
  const thumbWidth = createMemo(() =>
    Math.max(MIN_THUMB_WIDTH, sidebarWidth() - HORIZONTAL_PADDING),
  );
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [renderWidth, setRenderWidth] = createSignal(thumbWidth());
  const [dropSlot, setDropSlot] = createSignal<number | null>(null);
  let menuEl: HTMLUListElement | undefined;
  let listEl: HTMLDivElement | undefined;

  // Re-render thumbnails 200 ms after the width stops changing.
  createEffect(() => {
    const width = thumbWidth();
    const timer = setTimeout(() => setRenderWidth(width), RERENDER_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });

  // Keep the active thumbnail in view.
  createEffect(() => {
    const index = tab().currentPage;
    queueMicrotask(() => {
      listEl
        ?.querySelector<HTMLElement>(`[data-page-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  // Clamp the context menu to the viewport once its size is known.
  createEffect(() => {
    const state = menu();
    if (!state || state.clamped || !menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const pos = clampMenuPosition(
      state.x,
      state.y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    );
    setMenu({ ...state, ...pos, clamped: true });
  });

  const closeMenu = () => setMenu(null);

  createEffect(() => {
    if (!menu()) return;
    const onDoc = () => closeMenu();
    window.addEventListener("pointerdown", onDoc, { once: true });
    onCleanup(() => window.removeEventListener("pointerdown", onDoc));
  });

  const handleClick = (event: MouseEvent, index: number) => {
    if (event.shiftKey) {
      extendPageSelection(index);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      togglePageSelection(index);
      return;
    }
    setSinglePageSelection(index);
  };

  const handleContextMenu = (event: MouseEvent, index: number) => {
    event.preventDefault();
    const t = tab();
    if (!t.selectedPageIndices.includes(index)) {
      setSinglePageSelection(index);
    }
    setMenu({ x: event.clientX, y: event.clientY, pageIndex: index });
  };

  const beginResize = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = uiStore.sidebarWidth;
    target.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      setUiStore(
        "sidebarWidth",
        clampSidebarWidth(startWidth + (moveEvent.clientX - startX)),
      );
    };
    const onUp = (upEvent: PointerEvent) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      if (target.hasPointerCapture(upEvent.pointerId)) {
        target.releasePointerCapture(upEvent.pointerId);
      }
      document.body.classList.remove("resizing-sidebar");
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
    document.body.classList.add("resizing-sidebar");
  };

  const onResetWidth = (event: MouseEvent) => {
    event.preventDefault();
    setUiStore("sidebarWidth", clampSidebarWidth(168));
  };

  const onDragStart = (event: DragEvent, index: number) => {
    if (tab().readOnly) {
      event.preventDefault();
      return;
    }
    if (!tab().selectedPageIndices.includes(index)) setSinglePageSelection(index);
    event.dataTransfer?.setData("application/x-rustypdf-pages", "1");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (event: DragEvent, index: number) => {
    if (!event.dataTransfer?.types.includes("application/x-rustypdf-pages")) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setDropSlot(dropSlotForPointer(index, event.clientY, rect.top, rect.height));
  };
  const onDrop = (event: DragEvent) => {
    const slot = dropSlot();
    setDropSlot(null);
    if (slot === null) return;
    event.preventDefault();
    void moveSelectedPages(slot);
  };

  const selectedSet = createMemo(() => new Set(tab().selectedPageIndices));

  const runMenuAction = async (action: () => unknown) => {
    closeMenu();
    await action();
  };

  return (
    <aside
      class="thumbnail-sidebar"
      aria-label="page thumbnails"
    >
      <div class="thumbnail-list" ref={listEl}>
        <For each={tab().pages}>
          {(page, index) => (
            <button
              type="button"
              class="thumbnail-item"
              classList={{
                active: tab().currentPage === index(),
                selected: selectedSet().has(index()),
                "drop-before": dropSlot() === index(),
                "drop-after":
                  dropSlot() === index() + 1 && index() === tab().pageCount - 1,
              }}
              data-page-index={index()}
              draggable={!tab().readOnly}
              onDragStart={(event) => onDragStart(event, index())}
              onDragOver={(event) => onDragOver(event, index())}
              onDragLeave={() => setDropSlot(null)}
              onDragEnd={() => setDropSlot(null)}
              onDrop={onDrop}
              onClick={(event) => {
                const retry = event.currentTarget.querySelector<HTMLElement>(".thumbnail-error");
                if (retry) { retry.click(); return; }
                handleClick(event, index());
              }}
              onContextMenu={(event) => handleContextMenu(event, index())}
            >
              <ThumbnailCanvas
                page={page}
                index={index()}
                docId={tab().docId}
                revision={tab().revision}
                contentVersion={tab().contentVersion}
                thumbWidth={thumbWidth()}
                renderWidth={renderWidth()}
              />
              <span>{index() + 1}</span>
            </button>
          )}
        </For>
      </div>
      <div
        class="thumbnail-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="썸네일 너비 조절"
        onPointerDown={beginResize}
        onDblClick={onResetWidth}
        title="드래그해서 폭 조절 (더블클릭으로 기본값)"
      />
      <Show when={menu()}>
        {(state) => (
          <ul
            class="thumbnail-context-menu"
            ref={menuEl}
            style={{ left: `${state().x}px`, top: `${state().y}px` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <li>
              <button onClick={() => runMenuAction(copySelectedPages)}>
                복사 ({tab().selectedPageIndices.length})
                <span class="kbd">{shortcutLabel("C")}</span>
              </button>
            </li>
            <li>
              <button onClick={() => runMenuAction(cutSelectedPages)}>
                잘라내기
                <span class="kbd">{shortcutLabel("X")}</span>
              </button>
            </li>
            <li>
              <button
                disabled={!pageClipboard.token}
                onClick={() =>
                  runMenuAction(() => pastePagesAfter(state().pageIndex))
                }
              >
                붙여넣기
                {pageClipboard.token ? ` (${pageClipboard.count})` : ""}
                <span class="kbd">{shortcutLabel("V")}</span>
              </button>
            </li>
            <li>
              <button onClick={() => runMenuAction(duplicateSelectedPages)}>
                복제
                <span class="kbd">{shortcutLabel("D")}</span>
              </button>
            </li>
            <li>
              <button onClick={() => runMenuAction(() => rotateSelectedPages(1))}>
                시계 방향 회전
              </button>
            </li>
            <li>
              <button onClick={() => runMenuAction(() => rotateSelectedPages(-1))}>
                반시계 방향 회전
              </button>
            </li>
            <li class="separator" />
            <li>
              <button onClick={() => runMenuAction(extractSelectedPages)}>
                새 PDF로 추출
              </button>
            </li>
            <li>
              <button
                onClick={() =>
                  runMenuAction(() => insertPdfAfter(state().pageIndex))
                }
              >
                다른 PDF 삽입…
              </button>
            </li>
            <li class="separator" />
            <li>
              <button
                class="danger"
                onClick={() => runMenuAction(deleteSelectedPages)}
              >
                삭제
                <span class="kbd">Del</span>
              </button>
            </li>
          </ul>
        )}
      </Show>
    </aside>
  );
}
