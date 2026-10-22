import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { PageMeta } from "../state/document";
import { renderPage } from "../ipc/pdf";
import { AnnotationLayer } from "../annotations/AnnotationLayer";
import { TextLayer } from "../ocr/TextLayer";

interface Props {
  page: PageMeta;
  index: number;
  width: number; // rendered px
  height: number;
  docId: string;
  revision: number;
  contentVersion: number;
  zoom: number;
  rotation: 0 | 90 | 180 | 270;
}

// Bucket the zoom so we don't re-render for every tiny change.
function zoomBucket(z: number): number {
  return Math.round(z * 4) / 4; // 25% steps
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
    // Generous margin so the high-res render kicks off well before the page
    // scrolls into view. The bounded PDF.js cache reuses nearby bitmaps.
    { rootMargin: "1200px 0px", threshold: 0 },
  );
  return observer;
}

function paintRgba(canvas: HTMLCanvasElement, buf: ArrayBuffer) {
  if (buf.byteLength < 8) throw new Error("Incomplete page image");
  const view = new DataView(buf);
  const w = view.getUint32(0, false);
  const h = view.getUint32(4, false);
  // Guard against a header that disagrees with the payload length — otherwise
  // the Uint8ClampedArray view below throws a RangeError.
  if (w === 0 || h === 0 || buf.byteLength < 8 + w * h * 4) throw new Error("Invalid page image");
  const pixels = new Uint8ClampedArray(buf, 8, w * h * 4);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  // putImageData is the fastest path here: no decode, no scaling, no alpha
  // composite — just a straight blit into the backing store.
  const imageData = new ImageData(pixels, w, h);
  ctx.putImageData(imageData, 0, 0);
}

export function PageCanvas(props: Props) {
  let canvas!: HTMLCanvasElement;
  let frame!: HTMLDivElement;
  let renderSeq = 0;
  const [error, setError] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const [visible, setVisible] = createSignal(false);

  createEffect(() => {
    const el = frame;
    visibleHandlers.set(el, setVisible);
    getObserver().observe(el);
    onCleanup(() => {
      getObserver().unobserve(el);
      visibleHandlers.delete(el);
    });
  });

  // Render at the bucketed zoom whenever this page is near the viewport.
  // While the new render is in flight the canvas keeps the previous bitmap;
  // CSS stretches it to the new size — better than a blank frame and much
  // sharper than a half-resolution placeholder.
  createEffect(() => {
    if (!visible()) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    retry();
    setError(false);
    // Same docId can point at new bytes after overwrite-save.
    props.contentVersion;
    const bucket = zoomBucket(props.zoom);
    const rot = props.rotation;
    const idx = props.index;
    const id = props.docId;

    let cancelled = false;
    const seq = ++renderSeq;
    (async () => {
      try {
        const buf = await renderPage(id, props.revision, idx, bucket, rot);
        // Skip if this run was superseded — a newer render (zoom/rotation/
        // visibility change) must not be overwritten by an older one that
        // resolves late.
        if (cancelled || seq !== renderSeq) return;
        paintRgba(canvas, buf);
      } catch (err) {
        if (!cancelled && seq === renderSeq) { setError(true); console.error("render page failed", idx, err); }
      }
    })();
    onCleanup(() => {
      cancelled = true;
    });
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
          zoom={props.zoom}
          rotation={props.rotation}
        />
        <AnnotationLayer
          page={props.page}
          width={props.width}
          height={props.height}
          zoom={props.zoom}
          rotation={props.rotation}
        />
      </Show>
      <Show when={error()}><div class="render-error" role="alert"><span>페이지를 표시할 수 없습니다.</span><button onClick={() => setRetry(value => value + 1)}>다시 시도</button></div></Show>
      <div class="page-number">{props.index + 1}</div>
    </div>
  );
}
