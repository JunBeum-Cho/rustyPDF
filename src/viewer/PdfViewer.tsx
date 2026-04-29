import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js";
import { documentStore, setDocumentStore } from "../state/document";
import { uiStore } from "../state/ui";
import { renderPage } from "../ipc/pdf";
import { PageCanvas } from "./PageCanvas";
import { Thumbnails } from "./Thumbnails";
import "./viewer.css";

const PAGE_GAP = 16; // px between pages
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function nextZoom(cur: number): number | null {
  return ZOOM_STEPS.find((z) => z > cur) ?? null;
}

function prevZoom(cur: number): number | null {
  return [...ZOOM_STEPS].reverse().find((z) => z < cur) ?? null;
}

export function PdfViewer() {
  let scrollEl!: HTMLDivElement;

  const doc = createMemo(() => documentStore.doc!);

  const renderedDims = createMemo(() => {
    const z = documentStore.zoom;
    const rot = documentStore.rotation;
    const swap = rot === 90 || rot === 270;
    return doc().pages.map((p) => ({
      width: (swap ? p.height : p.width) * z,
      height: (swap ? p.width : p.height) * z,
    }));
  });

  // Estimate visible page from scroll position
  function onScroll() {
    const dims = renderedDims();
    let acc = 0;
    const center = scrollEl.scrollTop + scrollEl.clientHeight / 2;
    for (let i = 0; i < dims.length; i++) {
      const next = acc + dims[i].height + PAGE_GAP;
      if (center < next) {
        if (documentStore.currentPage !== i) {
          setDocumentStore("currentPage", i);
        }
        return;
      }
      acc = next;
    }
  }

  // Sync external currentPage changes (toolbar prev/next) to scroll position
  let suppressNextScroll = false;
  function scrollToPage(i: number) {
    const dims = renderedDims();
    let top = 0;
    for (let k = 0; k < i; k++) top += dims[k].height + PAGE_GAP;
    suppressNextScroll = true;
    scrollEl.scrollTo({ top, behavior: "auto" });
  }

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
      // Cmd/Ctrl + wheel → zoom (also catches trackpad pinch which sets ctrlKey)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const cur = documentStore.zoom;
        const target = e.deltaY < 0 ? nextZoom(cur) : prevZoom(cur);
        if (target == null) return;

        // Zoom around the cursor: keep the document point under the cursor in
        // place after the size change.
        const rect = scrollEl.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const docX = scrollEl.scrollLeft + cx;
        const docY = scrollEl.scrollTop + cy;
        const ratio = target / cur;

        setDocumentStore("zoom", target);
        // Layout updates after the next frame.
        requestAnimationFrame(() => {
          scrollEl.scrollLeft = docX * ratio - cx;
          scrollEl.scrollTop = docY * ratio - cy;
        });
        return;
      }

      // Alt + vertical wheel → horizontal pan
      if (e.altKey && e.deltaY !== 0 && e.deltaX === 0) {
        e.preventDefault();
        scrollEl.scrollLeft += e.deltaY;
      }
    };
    scrollEl.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => scrollEl.removeEventListener("wheel", onWheel));
  });

  // Background prefetch for small docs: warm the LRU cache with every page
  // so the user never sees a blank/blur frame regardless of scroll speed.
  // For larger docs we rely on the viewport-margin prefetch in PageCanvas.
  createEffect(
    on(
      () => [doc().id, documentStore.zoom, documentStore.rotation] as const,
      ([docId, zoom, rotation]) => {
        if (doc().prefetchPolicy !== "all") return;

        let aborted = false;
        const bucket = Math.round(zoom * 4) / 4;
        const concurrency = 3;

        // Order: pages near the current page first, then outwards.
        const total = doc().pageCount;
        const start = documentStore.currentPage;
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
              /* ignored: visible page render will surface real errors */
            }
            // Yield so we don't starve high-priority visible-page renders.
            await new Promise((r) => setTimeout(r, 0));
          }
        }

        const workers = Array.from({ length: concurrency }, worker);
        Promise.allSettled(workers).then(() => {
          /* done */
        });

        onCleanup(() => {
          aborted = true;
          order.length = 0;
        });
      }
    )
  );

  // Reactive: when currentPage changes from outside (toolbar), scroll
  let lastPage = -1;
  const _ = createMemo(() => {
    const p = documentStore.currentPage;
    if (p !== lastPage) {
      lastPage = p;
      // wait for layout
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
          <For each={doc().pages}>
            {(page, i) => (
              <PageCanvas
                page={page}
                index={i()}
                width={renderedDims()[i()].width}
                height={renderedDims()[i()].height}
                docId={doc().id}
                zoom={documentStore.zoom}
                rotation={documentStore.rotation}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
