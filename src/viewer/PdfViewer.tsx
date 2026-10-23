import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { activeTab, updateActiveTab } from "../state/document";
import { setUiStore, uiStore } from "../state/ui";

import { PageCanvas } from "./PageCanvas";
import { Thumbnails } from "./Thumbnails";
import { Outline } from "./Outline";
import { clearPageSelection } from "./pageClipboard";
import "./viewer.css";

import { fitZoom, navigationMode, pxPerPt, setManualZoom } from "./navigation";

const PAGE_GAP = 16;

export function PdfViewer() {
  let scrollEl!: HTMLDivElement;

  const tab = createMemo(() => activeTab()!);

  const renderedDims = createMemo(() => {
    const t = tab();
    const k = pxPerPt(t.zoom);
    return t.pages.map((p) => ({ width: p.width * k, height: p.height * k }));
  });

  const scrollPositions = new Map<string, { top: number; left: number }>();
  let displayedTabId = tab().tabId;
  function onScroll() {
    if (displayedTabId !== tab().tabId) return;
    scrollPositions.set(displayedTabId, {
      top: scrollEl.scrollTop,
      left: scrollEl.scrollLeft,
    });
    const dims = renderedDims();
    let acc = 0;
    const center = scrollEl.scrollTop + scrollEl.clientHeight / 2;
    for (let i = 0; i < dims.length; i++) {
      const next = acc + dims[i].height + PAGE_GAP;
      if (center < next) {
        if (tab().currentPage !== i) {
          updateActiveTab((t) => {
            t.currentPage = i;
          });
        }
        return;
      }
      acc = next;
    }
  }

  let suppressNextScroll = false;
  function scrollToPage(i: number, tabId: string) {
    if (tab().tabId !== tabId || displayedTabId !== tabId) return;
    const dims = renderedDims();
    let top = 0;
    for (let k = 0; k < i; k++) top += dims[k].height + PAGE_GAP;
    suppressNextScroll = true;
    scrollEl.scrollTo({ top, behavior: "auto" });
    scrollPositions.set(tabId, {
      top: scrollEl.scrollTop,
      left: scrollEl.scrollLeft,
    });
  }

  // Restore each tab independently; reject work queued for an older tab.
  createEffect(
    on(
      () => tab().tabId,
      (tabId) => {
        queueMicrotask(() => {
          if (tab().tabId !== tabId) return;
          suppressNextScroll = true;
          const saved = scrollPositions.get(tabId);
          scrollEl.scrollTo({
            top: saved?.top ?? 0,
            left: saved?.left ?? 0,
            behavior: "auto",
          });
          displayedTabId = tabId;
        });
      },
      { defer: true },
    ),
  );

  const [viewport, setViewport] = createSignal({ width: 0, height: 0 });
  createEffect(() => {
    const t = tab();
    const mode = navigationMode(t.tabId);
    const size = viewport();
    if (mode === "manual" || !t.pages.length || !size.width || !size.height) return;
    // Widest page for width mode, largest page for page mode; never currentPage.
    const pageW = Math.max(...t.pages.map((p) => p.width));
    const pageH = Math.max(...t.pages.map((p) => p.height));
    const zoom = fitZoom(mode, size.width, size.height, pageW, pageH);
    if (Math.abs(t.zoom - zoom) > .0001) updateActiveTab(t => { t.zoom = zoom; });
  });

  onMount(() => {
    const resize = new ResizeObserver(() => setViewport({ width: scrollEl.clientWidth, height: scrollEl.clientHeight }));
    resize.observe(scrollEl);
    onCleanup(() => resize.disconnect());
    const handler = () => {
      if (suppressNextScroll) {
        suppressNextScroll = false;
        return;
      }
      onScroll();
    };
    scrollEl.addEventListener("scroll", handler, { passive: true });
    onCleanup(() => scrollEl.removeEventListener("scroll", handler));

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const t = tab();
        const cur = t.zoom;
        const target = Math.min(4, Math.max(0.25, cur * Math.exp(-e.deltaY * 0.01)));
        if (Math.abs(target - cur) < 1e-9) return;

        const rect = scrollEl.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const docX = scrollEl.scrollLeft + cx;
        const docY = scrollEl.scrollTop + cy;
        const ratio = target / cur;
        // Anchor at the pointer; mode switches to manual inside setManualZoom.

        setManualZoom(target);
        const zoomTabId = t.tabId;
        requestAnimationFrame(() => {
          if (tab().tabId !== zoomTabId || displayedTabId !== zoomTabId) return;
          scrollEl.scrollLeft = docX * ratio - cx;
          scrollEl.scrollTop = docY * ratio - cy;
          scrollPositions.set(zoomTabId, {
            top: scrollEl.scrollTop,
            left: scrollEl.scrollLeft,
          });
        });
        return;
      }

      if (e.altKey && e.deltaY !== 0 && e.deltaX === 0) {
        e.preventDefault();
        scrollEl.scrollLeft += e.deltaY;
      }
    };
    scrollEl.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => scrollEl.removeEventListener("wheel", onWheel));
  });

  createEffect(
    on(
      () => [tab().tabId, tab().navigationVersion] as const,
      ([id], previous) => {
        if (previous && previous[0] === id) {
          const page = tab().currentPage;
          queueMicrotask(() => scrollToPage(page, id));
        }
      },
      { defer: true },
    ),
  );

  const [systemDark, setSystemDark] = createSignal(false);
  onMount(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    setSystemDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    onCleanup(() => mq.removeEventListener("change", on));
  });
  const effectiveDark = () => uiStore.theme === "dark" || (uiStore.theme === "auto" && systemDark());

  return (
    <div class="viewer-shell">
      <Show when={uiStore.sidebarOpen}>
        <div class="sidebar-pane" style={{ width: `${uiStore.sidebarWidth}px` }}>
          <div class="sidebar-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              classList={{ active: uiStore.sidebarMode === "thumbnails" }}
              aria-selected={uiStore.sidebarMode === "thumbnails"}
              onClick={() => setUiStore("sidebarMode", "thumbnails")}
            >
              썸네일
            </button>
            <button
              type="button"
              role="tab"
              classList={{ active: uiStore.sidebarMode === "outline" }}
              aria-selected={uiStore.sidebarMode === "outline"}
              onClick={() => setUiStore("sidebarMode", "outline")}
            >
              목차
            </button>
          </div>
          <Show when={uiStore.sidebarMode === "outline"} fallback={<Thumbnails />}>
            <Outline />
          </Show>
        </div>
      </Show>
      <div
        class="viewer-scroll"
        classList={{ "invert-pages": uiStore.invertPagesInDark && effectiveDark() }}
        ref={scrollEl}
        onPointerDown={() => clearPageSelection()}
      >
        <div class="viewer-stack">
          <For each={tab().pages}>
            {(page, i) => (
              <PageCanvas
                page={page}
                index={i()}
                width={renderedDims()[i()].width}
                height={renderedDims()[i()].height}
                docId={tab().docId}
                revision={tab().revision}
                contentVersion={tab().contentVersion}
                scale={pxPerPt(tab().zoom)}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
