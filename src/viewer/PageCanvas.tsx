import { createEffect, createSignal, onCleanup } from "solid-js";
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
    // scrolls into view. With the LRU + Rust-side cache this almost always
    // means the bitmap is ready by the time the user gets there.
    { rootMargin: "1200px 0px", threshold: 0 }
  );
  return observer;
}

function paintRgba(canvas: HTMLCanvasElement, buf: ArrayBuffer) {
  const view = new DataView(buf);
  const w = view.getUint32(0, false);
  const h = view.getUint32(4, false);
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
  const [visible, setVisible] = createSignal(false);

  createEffect(() => {
    const el = canvas;
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
    if (!visible()) return;
    const bucket = zoomBucket(props.zoom);
    const rot = props.rotation;
    const idx = props.index;
    const id = props.docId;

    let cancelled = false;
    (async () => {
      try {
        const buf = await renderPage(id, idx, bucket, rot);
        if (cancelled) return;
        paintRgba(canvas, buf);
      } catch (err) {
        if (!cancelled) console.error("render page failed", idx, err);
      }
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  return (
    <div
      class="page-frame"
      data-page-index={props.index}
      style={{ width: `${props.width}px`, height: `${props.height}px` }}
    >
      <canvas
        ref={canvas}
        class="page-canvas"
        style={{ width: "100%", height: "100%" }}
      />
      <TextLayer
        pageIndex={props.index}
        width={props.width}
        height={props.height}
      />
      <AnnotationLayer
        page={props.page}
        width={props.width}
        height={props.height}
        zoom={props.zoom}
        rotation={props.rotation}
      />
      <div class="page-number">{props.index + 1}</div>
    </div>
  );
}
