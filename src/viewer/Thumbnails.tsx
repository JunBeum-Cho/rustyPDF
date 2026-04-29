import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { renderPage } from "../ipc/pdf";
import { activeTab, type PageMeta } from "../state/document";
import { clampSidebarWidth, setUiStore, uiStore } from "../state/ui";
import {
  copySelectedPages,
  cutSelectedPages,
  deleteSelectedPages,
  duplicateSelectedPages,
  extendPageSelection,
  pageClipboard,
  pastePagesAfter,
  setSinglePageSelection,
  togglePageSelection,
} from "./pageClipboard";

interface ThumbnailCanvasProps {
  page: PageMeta;
  index: number;
  docId: string;
  rotation: 0 | 90 | 180 | 270;
  thumbWidth: number;
}

const HORIZONTAL_PADDING = 32;
const MIN_THUMB_WIDTH = 80;

const thumbnailScale = (
  page: PageMeta,
  rotation: 0 | 90 | 180 | 270,
  thumbWidth: number,
) => {
  const displayWidth = rotation === 90 || rotation === 270 ? page.height : page.width;
  return thumbWidth / displayWidth;
};

const thumbnailHeight = (
  page: PageMeta,
  rotation: 0 | 90 | 180 | 270,
  thumbWidth: number,
) => {
  const displayHeight = rotation === 90 || rotation === 270 ? page.width : page.height;
  return displayHeight * thumbnailScale(page, rotation, thumbWidth);
};

function paintRgba(canvas: HTMLCanvasElement, buf: ArrayBuffer) {
  const view = new DataView(buf);
  const w = view.getUint32(0, false);
  const h = view.getUint32(4, false);
  const pixels = new Uint8ClampedArray(buf, 8, w * h * 4);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
}

function ThumbnailCanvas(props: ThumbnailCanvasProps) {
  let canvas!: HTMLCanvasElement;
  const [visible, setVisible] = createSignal(false);
  const scale = createMemo(() =>
    thumbnailScale(props.page, props.rotation, props.thumbWidth),
  );
  const height = createMemo(() =>
    thumbnailHeight(props.page, props.rotation, props.thumbWidth),
  );

  createEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { rootMargin: "480px 0px", threshold: 0 },
    );
    observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (!visible()) return;
    const currentScale = scale();
    const docId = props.docId;
    const idx = props.index;
    const rot = props.rotation;
    let cancelled = false;
    (async () => {
      try {
        const buf = await renderPage(docId, idx, currentScale, rot);
        if (!cancelled) paintRgba(canvas, buf);
      } catch (error) {
        if (!cancelled) console.error("render thumbnail failed", idx, error);
      }
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  return (
    <canvas
      ref={canvas}
      class="thumbnail-canvas"
      style={{ width: `${props.thumbWidth}px`, height: `${height()}px` }}
    />
  );
}

interface MenuState {
  x: number;
  y: number;
  pageIndex: number;
}

export function Thumbnails() {
  const tab = createMemo(() => activeTab()!);
  const sidebarWidth = createMemo(() => uiStore.sidebarWidth);
  const thumbWidth = createMemo(() =>
    Math.max(MIN_THUMB_WIDTH, sidebarWidth() - HORIZONTAL_PADDING),
  );
  const [menu, setMenu] = createSignal<MenuState | null>(null);

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

  const selectedSet = createMemo(() => new Set(tab().selectedPageIndices));

  const runMenuAction = async (action: () => Promise<void> | void) => {
    closeMenu();
    await action();
  };

  return (
    <aside
      class="thumbnail-sidebar"
      aria-label="page thumbnails"
      style={{
        width: `${sidebarWidth()}px`,
        flex: `0 0 ${sidebarWidth()}px`,
      }}
    >
      <div class="thumbnail-list">
        <For each={tab().pages}>
          {(page, index) => (
            <button
              type="button"
              class="thumbnail-item"
              classList={{
                active: tab().currentPage === index(),
                selected: selectedSet().has(index()),
              }}
              onClick={(event) => handleClick(event, index())}
              onContextMenu={(event) => handleContextMenu(event, index())}
            >
              <ThumbnailCanvas
                page={page}
                index={index()}
                docId={tab().docId}
                rotation={tab().rotation}
                thumbWidth={thumbWidth()}
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
            style={{ left: `${state().x}px`, top: `${state().y}px` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <li>
              <button
                onClick={() => runMenuAction(copySelectedPages)}
              >
                복사 ({tab().selectedPageIndices.length})
                <span class="kbd">⌘C</span>
              </button>
            </li>
            <li>
              <button onClick={() => runMenuAction(cutSelectedPages)}>
                잘라내기
                <span class="kbd">⌘X</span>
              </button>
            </li>
            <li>
              <button
                disabled={!pageClipboard.token}
                onClick={() => runMenuAction(() => pastePagesAfter(state().pageIndex))}
              >
                붙여넣기
                {pageClipboard.token ? ` (${pageClipboard.count})` : ""}
                <span class="kbd">⌘V</span>
              </button>
            </li>
            <li>
              <button onClick={() => runMenuAction(duplicateSelectedPages)}>
                복제
                <span class="kbd">⌘D</span>
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
