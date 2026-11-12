import { Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { PageMeta } from "../state/document";
import { boundedViewport, pdfEngine } from "../platform/pdf-engine";
import { AnnotationLayer } from "../annotations/AnnotationLayer";
import { TextLayer } from "../ocr/TextLayer";
import { PdfAnnotationOverlay } from "./PdfAnnotationOverlay";

interface Props {
  page: PageMeta;
  index: number;
  width: number; // rendered CSS px
  height: number;
  docId: string;
  revision: number;
  contentVersion: number;
  scale: number; // CSS px per PDF point
}

const RERENDER_DELAY_MS = 150;
/** CSS px drawn beyond the visible area so short scrolls stay sharp. */
const DETAIL_MARGIN = 200;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** A drawn detail region plus the page size (CSS px) it was drawn at. */
interface Detail extends Rect {
  pageWidth: number;
  pageHeight: number;
}

function contains(outer: Rect, inner: Rect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

let observer: IntersectionObserver | null = null;
const visibleHandlers = new WeakMap<Element, (visible: boolean) => void>();

function getObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        visibleHandlers.get(entry.target)?.(entry.isIntersecting);
      }
    },
    // Generous margin so the render starts well before the page scrolls in.
    { rootMargin: "1200px 0px", threshold: 0 },
  );
  return observer;
}

export function PageCanvas(props: Props) {
  let canvas!: HTMLCanvasElement;
  let detailCanvas!: HTMLCanvasElement;
  let frame!: HTMLDivElement;
  const [error, setError] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const [visible, setVisible] = createSignal(false);
  let handle: { promise: Promise<void>; cancel(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rendered = false;

  const cancelRender = () => {
    clearTimeout(timer);
    timer = undefined;
    handle?.cancel();
    handle = null;
  };

  createEffect(() => {
    const el = frame;
    visibleHandlers.set(el, setVisible);
    getObserver().observe(el);
    onCleanup(() => {
      getObserver().unobserve(el);
      visibleHandlers.delete(el);
    });
  });

  // Draw at CSS size x devicePixelRatio. The first render is immediate; later
  // size changes wait for the zoom to settle, and the previous bitmap stays
  // stretched by CSS in the meantime.
  createEffect(() => {
    if (!visible()) {
      cancelRender();
      rendered = false;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    retry();
    props.contentVersion;
    const request = {
      docId: props.docId,
      revision: props.revision,
      pageIndex: props.index,
      cssWidth: props.width,
      cssHeight: props.height,
      dpr: window.devicePixelRatio || 1,
    };
    cancelRender();
    const run = () => {
      timer = undefined;
      setError(false);
      const current = pdfEngine().renderPage(canvas, request);
      handle = current;
      rendered = true;
      current.promise.catch((err) => {
        if (handle !== current) return;
        setError(true);
        console.error("render page failed", request.pageIndex, err);
      });
    };
    if (rendered) timer = setTimeout(run, RERENDER_DELAY_MS);
    else run();
    onCleanup(cancelRender);
  });

  // Large pages at high zoom exceed boundedViewport, so the whole-page bitmap
  // is drawn below device resolution. Like PDF.js's detail view, draw the
  // visible part again at full resolution on a canvas laid over it. It is
  // positioned in percent of the page, so it stays aligned (just stretched)
  // while a zoom settles.
  const [detail, setDetail] = createSignal<Detail | null>(null);
  let detailHandle: { promise: Promise<void>; cancel(): void } | null = null;
  let detailTimer: ReturnType<typeof setTimeout> | undefined;
  let shown: { key: string; rect: Rect } | null = null;
  let pending: { key: string; rect: Rect } | null = null;

  const detailKey = () =>
    [
      props.docId,
      props.revision,
      props.contentVersion,
      props.index,
      props.width,
      props.height,
      window.devicePixelRatio || 1,
      retry(),
    ].join(":");

  const needsDetail = () => {
    const dpr = window.devicePixelRatio || 1;
    if (!(props.width > 0 && props.height > 0)) return false;
    return boundedViewport(props.width * dpr, props.height * dpr).ratio < 1;
  };

  /** The page's visible part (CSS px of the page), grown by `margin`. */
  const visibleRect = (margin: number): Rect | null => {
    const scroller = frame.closest(".viewer-scroll");
    if (!scroller) return null;
    const view = scroller.getBoundingClientRect();
    const page = frame.getBoundingClientRect();
    const x0 = Math.max(0, Math.floor(view.left - page.left - margin));
    const y0 = Math.max(0, Math.floor(view.top - page.top - margin));
    const x1 = Math.min(props.width, Math.ceil(view.right - page.left + margin));
    const y1 = Math.min(props.height, Math.ceil(view.bottom - page.top + margin));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  const clearDetail = () => {
    clearTimeout(detailTimer);
    detailTimer = undefined;
    detailHandle?.cancel();
    detailHandle = null;
    shown = pending = null;
    setDetail(null);
    if (detailCanvas) detailCanvas.width = detailCanvas.height = 0;
  };

  const covered = (view: Rect, key: string) =>
    [shown, pending].some((d) => d && d.key === key && contains(d.rect, view));

  const runDetail = () => {
    detailTimer = undefined;
    if (!visible() || !needsDetail()) return clearDetail();
    const view = visibleRect(0);
    const key = detailKey();
    if (!view || covered(view, key)) return;
    const rect = visibleRect(DETAIL_MARGIN)!;
    const request = {
      docId: props.docId,
      revision: props.revision,
      pageIndex: props.index,
      cssWidth: props.width,
      cssHeight: props.height,
      dpr: window.devicePixelRatio || 1,
    };
    detailHandle?.cancel();
    const current = pdfEngine().renderRegion(detailCanvas, request, rect);
    detailHandle = current;
    pending = { key, rect };
    current.promise.then(
      () => {
        if (detailHandle !== current) return;
        detailHandle = pending = null;
        shown = { key, rect };
        setDetail({ ...rect, pageWidth: request.cssWidth, pageHeight: request.cssHeight });
      },
      (err) => {
        if (detailHandle !== current) return;
        detailHandle = pending = null;
        console.error("render page detail failed", request.pageIndex, err);
      },
    );
  };

  const updateDetail = () => {
    if (!visible()) return clearDetail();
    if (!needsDetail() && !shown && !pending) return;
    const view = visibleRect(0);
    if (view && covered(view, detailKey())) return;
    clearTimeout(detailTimer);
    detailTimer = setTimeout(runDetail, RERENDER_DELAY_MS);
  };

  createEffect(() => {
    detailKey();
    if (!visible()) return untrack(clearDetail);
    untrack(updateDetail);
    const scroller = frame.closest(".viewer-scroll");
    if (!scroller) return;
    const onMove = () => updateDetail();
    scroller.addEventListener("scroll", onMove, { passive: true });
    const resize = new ResizeObserver(onMove);
    resize.observe(scroller);
    onCleanup(() => {
      scroller.removeEventListener("scroll", onMove);
      resize.disconnect();
    });
  });
  onCleanup(clearDetail);

  return (
    <div
      ref={frame}
      class="page-frame"
      data-page-index={props.index}
      style={{ width: `${props.width}px`, height: `${props.height}px` }}
    >
      <canvas
        ref={canvas}
        class="page-canvas"
        style={{ width: "100%", height: "100%" }}
      />
      <canvas
        ref={detailCanvas}
        class="page-canvas page-detail-canvas"
        aria-hidden="true"
        style={(() => {
          const d = detail();
          if (!d) return { display: "none" };
          return {
            left: `${(d.x / d.pageWidth) * 100}%`,
            top: `${(d.y / d.pageHeight) * 100}%`,
            width: `${(d.w / d.pageWidth) * 100}%`,
            height: `${(d.h / d.pageHeight) * 100}%`,
          };
        })()}
      />
      <Show when={visible()}>
        <TextLayer
          pageIndex={props.index}
          page={props.page}
          revision={props.revision}
          contentVersion={props.contentVersion}
          zoom={props.scale}
        />
        <PdfAnnotationOverlay
          docId={props.docId}
          revision={props.revision}
          pageIndex={props.index}
          scale={props.scale}
        />
        <AnnotationLayer
          page={props.page}
          width={props.width}
          height={props.height}
          zoom={props.scale}
        />
      </Show>
      <Show when={error()}>
        <div class="render-error" role="alert">
          <span>페이지를 표시할 수 없습니다.</span>
          <button onClick={() => setRetry((value) => value + 1)}>다시 시도</button>
        </div>
      </Show>
      <div class="page-number">{props.index + 1}</div>
    </div>
  );
}
