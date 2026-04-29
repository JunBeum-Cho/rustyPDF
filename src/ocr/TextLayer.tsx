import { For, createEffect, createSignal, on, onMount } from "solid-js";
import { ocrPdfLines, pdfNativeTextLines, type OcrLine } from "../ipc/pdf";
import { activeTab } from "../state/document";
import { ocrState } from "./ocr";
import "./textLayer.css";

interface Props {
  pageIndex: number;
  /** Display width of the page in CSS pixels (after zoom). */
  width: number;
  height: number;
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
  const [lines, setLines] = createSignal<OcrLine[]>([]);

  createEffect(
    on(
      () => {
        const tab = activeTab();
        if (!tab) return null;
        const doc = ocrState.byDoc[tab.docId];
        return [tab.docId, props.pageIndex, doc?.done.size ?? 0] as const;
      },
      async (deps) => {
        if (!deps) return;
        const [docId, pageIndex] = deps;
        try {
          const native = await pdfNativeTextLines(docId, pageIndex);
          if (native.length > 0) {
            setLines(native);
            return;
          }
          const ocr = await ocrPdfLines(docId, pageIndex);
          setLines(ocr ?? []);
        } catch (error) {
          console.warn("text-layer fetch failed", error);
          setLines([]);
        }
      },
    ),
  );

  return (
    <div
      class="ocr-text-layer"
      style={{
        width: `${props.width}px`,
        height: `${props.height}px`,
      }}
    >
      <For each={lines()}>
        {(line) => <Line line={line} pageWidth={() => props.width} pageHeight={() => props.height} />}
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
