import { For, createEffect, createSignal, on } from "solid-js";
import { ocrPdfLines, type OcrLine } from "../ipc/pdf";
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
 * bitmap. Lets the user drag-select OCR'd text and copy it via the standard
 * browser keyboard shortcut. Each line is positioned in normalized 0–1
 * coords from the OCR engine, scaled into the page's display rectangle.
 */
export function TextLayer(props: Props) {
  const [lines, setLines] = createSignal<OcrLine[]>([]);

  // Pull lines whenever the page or its OCR status changes (newly recognized
  // page → fetch). The dependency on `done` size is what triggers refresh
  // after a manual OCR run finishes.
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
        const [docId, pageIndex, _doneCount] = deps;
        void _doneCount;
        try {
          const fetched = await ocrPdfLines(docId, pageIndex);
          setLines(fetched ?? []);
        } catch (error) {
          console.warn("ocr lines fetch failed", error);
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
        {(line) => {
          // Normalized → display pixels.
          const left = line.x * props.width;
          const top = line.y * props.height;
          const w = line.w * props.width;
          const h = line.h * props.height;
          // Use bbox height as the font size — close enough for most fonts
          // that selection highlight matches the actual ink bounds. We
          // letter-stretch so the rendered text fills the bbox width and
          // selection covers the OCR ink rather than overflowing.
          return (
            <span
              class="ocr-text-line"
              style={{
                left: `${left}px`,
                top: `${top}px`,
                width: `${w}px`,
                height: `${h}px`,
                "font-size": `${h}px`,
                "line-height": `${h}px`,
              }}
            >
              {line.text}
            </span>
          );
        }}
      </For>
    </div>
  );
}
