import { For, createEffect, createSignal, on, onMount } from "solid-js";
import { ocrPdfLines, pdfNativeTextLines, type OcrLine } from "../ipc/pdf";
import { activeTab } from "../state/document";
import type { PageMeta } from "../state/document";
import type { Rotation } from "../annotations/coords";
import { ocrState } from "./ocr";
import "./textLayer.css";

interface Props {
  pageIndex: number;
  page: PageMeta;
  revision: number;
  contentVersion: number;
  zoom: number;
  rotation: Rotation;
}

/**
 * Invisible-but-selectable text overlay aligned with the rendered page
 * bitmap. Each line is positioned in normalized 0–1 coords from the OCR /
 * pdfium text extraction; we measure the rendered glyph width at the
 * current zoom and apply `transform: scaleX(...)` so the system font's
 * natural width is squashed/stretched to exactly fill the original PDF
 * font's bbox width. Without this fix-up the selection highlight drifts
 * progressively the further you zoom from 100%.
 */
export function TextLayer(props: Props) {
  type LineSpace = "raw" | "display";
  const [layerData, setLayerData] = createSignal<{
    lines: OcrLine[];
    space: LineSpace;
  }>({ lines: [], space: "display" });

  // Pdfium reports page width/height *after* the PDF's intrinsic `/Rotate`,
  // but native text bounds live in the page's unrotated coordinate system.
  // OCR bounds, on the other hand, already describe the rendered page. Keep
  // track of which coordinate space we received so the selectable layer is
  // transformed exactly once.
  const rawPageWidth = () =>
    props.page.rotation === 90 || props.page.rotation === 270
      ? props.page.height
      : props.page.width;
  const rawPageHeight = () =>
    props.page.rotation === 90 || props.page.rotation === 270
      ? props.page.width
      : props.page.height;
  const basePageWidth = () =>
    (layerData().space === "raw" ? rawPageWidth() : props.page.width) *
    props.zoom;
  const basePageHeight = () =>
    (layerData().space === "raw" ? rawPageHeight() : props.page.height) *
    props.zoom;

  const layerRotation = (): Rotation => {
    const intrinsic = layerData().space === "raw" ? props.page.rotation : 0;
    return ((intrinsic + props.rotation) % 360) as Rotation;
  };

  const rotationTransform = () => {
    switch (layerRotation()) {
      case 90:
        return `translateX(${basePageHeight()}px) rotate(90deg)`;
      case 180:
        return `translate(${basePageWidth()}px, ${basePageHeight()}px) rotate(180deg)`;
      case 270:
        return `translateY(${basePageWidth()}px) rotate(270deg)`;
      default:
        return "none";
    }
  };

  let fetchSequence = 0;
  createEffect(
    on(
      () => {
        const tab = activeTab();
        if (!tab) return null;
        const doc = ocrState.byDoc[tab.docId];
        return [
          tab.docId,
          props.revision,
          props.pageIndex,
          doc?.done.size ?? 0,
          props.contentVersion,
        ] as const;
      },
      async (deps) => {
        if (!deps) return;
        const sequence = ++fetchSequence;
        const [docId, revision, pageIndex] = deps;
        try {
          const native = await pdfNativeTextLines(docId, revision, pageIndex);
          if (sequence !== fetchSequence) return;
          if (native.length > 0) {
            setLayerData({ lines: native, space: "raw" });
            return;
          }
          const ocr = await ocrPdfLines(docId, revision, pageIndex);
          if (sequence !== fetchSequence) return;
          setLayerData({ lines: ocr ?? [], space: "display" });
        } catch (error) {
          if (sequence !== fetchSequence) return;
          console.warn("text-layer fetch failed", error);
          setLayerData({ lines: [], space: "display" });
        }
      },
    ),
  );

  return (
    <div
      class="ocr-text-layer"
      style={{
        width: `${basePageWidth()}px`,
        height: `${basePageHeight()}px`,
        transform: rotationTransform(),
      }}
    >
      <For each={layerData().lines}>
        {(line) => (
          <Line
            line={line}
            pageWidth={basePageWidth}
            pageHeight={basePageHeight}
          />
        )}
      </For>
    </div>
  );
}

interface LineProps {
  line: OcrLine;
  pageWidth: () => number;
  pageHeight: () => number;
}

function Line(props: LineProps) {
  let span!: HTMLSpanElement;
  const [scaleX, setScaleX] = createSignal(1);

  // Re-measure whenever the page dimensions change. `scrollWidth` reports
  // the unscaled natural glyph width, while `targetWidth` is the bbox
  // mapped into the current display. Applying `scaleX = target / natural`
  // makes the rendered text exactly fill the bbox so the user's selection
  // highlight matches the original PDF ink.
  const measure = () => {
    if (!span) return;
    const target = props.line.w * props.pageWidth();
    // Read the natural width with scaleX = 1; the previous transform is
    // applied via CSS variable below so we can temporarily neutralise it
    // by measuring `scrollWidth` (which is layout-only and ignores transforms).
    const natural = span.scrollWidth;
    if (natural <= 0 || target <= 0) {
      setScaleX(1);
      return;
    }
    setScaleX(target / natural);
  };

  onMount(() => {
    // Wait one frame for the browser to lay out the text at the requested
    // font-size before measuring; otherwise scrollWidth reads as 0 on
    // first render in some webkit builds.
    requestAnimationFrame(measure);
  });

  // Re-measure on zoom / page-size change.
  createEffect(
    on(
      () => [props.pageWidth(), props.pageHeight()] as const,
      () => requestAnimationFrame(measure),
    ),
  );

  return (
    <span
      ref={span}
      class="ocr-text-line"
      style={{
        left: `${props.line.x * props.pageWidth()}px`,
        top: `${props.line.y * props.pageHeight()}px`,
        height: `${props.line.h * props.pageHeight()}px`,
        "font-size": `${props.line.h * props.pageHeight()}px`,
        "line-height": `${props.line.h * props.pageHeight()}px`,
        transform: `scaleX(${scaleX()})`,
      }}
    >
      {props.line.text}
    </span>
  );
}
