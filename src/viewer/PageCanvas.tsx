import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { PageMeta } from "../state/document";
import { pdfEngine } from "../platform/pdf-engine";
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
