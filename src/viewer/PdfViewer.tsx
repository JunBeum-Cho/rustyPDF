import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js";
import { activeTab, updateActiveTab } from "../state/document";
import { uiStore } from "../state/ui";
import { renderPage } from "../ipc/pdf";
import { PageCanvas } from "./PageCanvas";
import { Thumbnails } from "./Thumbnails";
import "./viewer.css";

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

  function onScroll() {
    const dims = renderedDims();
    let acc = 0;
    const center = scrollEl.scrollTop + scrollEl.clientHeight / 2;
    for (let i = 0; i < dims.length; i++) {
      const next = acc + dims[i].height + PAGE_GAP;
      if (center < next) {
        if (tab().currentPage !== i) {
          updateActiveTab((t) => { t.currentPage = i; });
        }
        return;
      }
      acc = next;
    }
  }

  let suppressNextScroll = false;
  function scrollToPage(i: number) {
    const dims = renderedDims();
    let top = 0;
    for (let k = 0; k < i; k++) top += dims[k].height + PAGE_GAP;
    suppressNextScroll = true;
    scrollEl.scrollTo({ top, behavior: "auto" });
  }

  // Reset scroll when active tab changes
  createEffect(
    on(
      () => tab().tabId,
      () => {
        queueMicrotask(() => {
          suppressNextScroll = true;
          scrollEl.scrollTo({ top: 0, behavior: "auto" });
        });
      },
      { defer: true },
    ),
  );

  onMount(() => {
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
        if (target == null) return;

        const rect = scrollEl.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const docX = scrollEl.scrollLeft + cx;
        const docY = scrollEl.scrollTop + cy;
        const ratio = target / cur;

        updateActiveTab((tt) => { tt.zoom = target; });
        requestAnimationFrame(() => {
          scrollEl.scrollLeft = docX * ratio - cx;
          scrollEl.scrollTop = docY * ratio - cy;
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
      () => [tab().docId, tab().zoom, tab().rotation] as const,
      ([docId, zoom, rotation]) => {
        if (tab().prefetchPolicy !== "all") return;

        let aborted = false;
        const bucket = Math.round(zoom * 4) / 4;
        const concurrency = 3;

        const total = tab().pageCount;
        const start = tab().currentPage;
        const order: number[] = [];
        const seen = new Set<number>();
        for (let r = 0; r < total; r++) {
          for (const p of [start - r, start + r]) {
            if (p >= 0 && p < total && !seen.has(p)) {
              seen.add(p);
              order.push(p);
            }
          }
          if (seen.size >= total) break;
        }

        async function worker() {
          while (!aborted) {
            const idx = order.shift();
            if (idx === undefined) return;
            try {
              await renderPage(docId, idx, bucket, rotation);
            } catch {
              /* ignored */
            }
            await new Promise((r) => setTimeout(r, 0));
          }
        }

        const workers = Array.from({ length: concurrency }, worker);
        Promise.allSettled(workers).then(() => { /* done */ });

        onCleanup(() => {
          aborted = true;
          order.length = 0;
        });
      },
    ),
  );

  let lastPage = -1;
  let lastTabId: string | null = null;
  const _ = createMemo(() => {
    const t = tab();
    const p = t.currentPage;
    if (t.tabId !== lastTabId) {
      lastTabId = t.tabId;
      lastPage = p;
      return;
    }
    if (p !== lastPage) {
      lastPage = p;
      queueMicrotask(() => scrollToPage(p));
    }
  });
  void _;

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
