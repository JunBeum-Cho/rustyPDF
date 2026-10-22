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
import { uiStore } from "../state/ui";

import { PageCanvas } from "./PageCanvas";
import { Thumbnails } from "./Thumbnails";
import "./viewer.css";

import { fitZoom, navigationMode, setManualZoom, setNavigationMode } from "./navigation";

const PAGE_GAP = 16;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function nextZoom(cur: number): number | null {
  return ZOOM_STEPS.find((z) => z > cur) ?? null;
}

function prevZoom(cur: number): number | null {
  return [...ZOOM_STEPS].reverse().find((z) => z < cur) ?? null;
}

export function PdfViewer() {
  let scrollEl!: HTMLDivElement;

  const tab = createMemo(() => activeTab()!);

  const renderedDims = createMemo(() => {
    const t = tab();
    const z = t.zoom;
    const rot = t.rotation;
    const swap = rot === 90 || rot === 270;
    return t.pages.map((p) => ({
      width: (swap ? p.height : p.width) * z,
      height: (swap ? p.width : p.height) * z,
    }));
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
    const page = t.pages[t.currentPage];
    if (mode === "manual" || !page || !size.width || !size.height) return;
    const zoom = fitZoom(mode, size.width, size.height, page.width, page.height, t.rotation);
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
        const target = e.deltaY < 0 ? nextZoom(cur) : prevZoom(cur);
        setNavigationMode("manual");
        if (target == null) return;

        const rect = scrollEl.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const docX = scrollEl.scrollLeft + cx;
        const docY = scrollEl.scrollTop + cy;
        const ratio = target / cur;

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

  return (
    <div class="viewer-shell">
      <Show when={uiStore.sidebarOpen}>
        <Thumbnails />
      </Show>
      <div class="viewer-scroll" ref={scrollEl}>
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
                zoom={tab().zoom}
                rotation={tab().rotation}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
