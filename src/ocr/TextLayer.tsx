import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import { invoke } from "../platform/desktop";
import { pdfEngine } from "../platform/pdf-engine";
import type { OcrLine } from "../ipc/pdf";
import { activeTab } from "../state/document";
import type { PageMeta } from "../state/document";
import { ocrState } from "./ocr";
import "./textLayer.css";
import { activeSearchMatch } from "../search/store";

interface Props {
  pageIndex: number;
  page: PageMeta;
  revision: number;
  contentVersion: number;
  /** CSS px per PDF point (also the PDF.js viewport scale). */
  zoom: number;
}

const OCR_FONT = "-apple-system, system-ui, sans-serif";
let measureCtx: CanvasRenderingContext2D | null | undefined;
/** One shared canvas for every OCR line: no per-line layout reads. */
function naturalWidth(text: string, fontPx: number): number {
  if (measureCtx === undefined)
    measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = `400 100px ${OCR_FONT}`;
  return (measureCtx.measureText(text).width * fontPx) / 100;
}

/**
 * Selectable text over the page bitmap. Native text uses the PDF.js
 * TextLayer; pages without it use OCR lines. Everything is sized with the
 * `--total-scale-factor` CSS variable, so zooming never re-renders.
 */
export function TextLayer(props: Props) {
  let layer!: HTMLDivElement;
  const [ocrLines, setOcrLines] = createSignal<OcrLine[]>([]);

  const pageOcrDone = createMemo(() => {
    const tab = activeTab();
    return tab
      ? (ocrState.byDoc[tab.docId]?.done.has(props.pageIndex) ?? false)
      : false;
  });

  createEffect(() => {
    const zoom = String(props.zoom);
    layer.style.setProperty("--scale-factor", zoom);
    layer.style.setProperty("--total-scale-factor", zoom);
  });

  let sequence = 0;
  createEffect(
    on(
      () => {
        const tab = activeTab();
        return tab
          ? ([
              tab.docId,
              props.revision,
              props.pageIndex,
              pageOcrDone(),
              props.contentVersion,
            ] as const)
          : null;
      },
      async (deps) => {
        const mine = ++sequence;
        layer.replaceChildren();
        setOcrLines([]);
        if (!deps) return;
        const [docId, revision, pageIndex] = deps;
        let task: { cancel(): void } | undefined;
        onCleanup(() => task?.cancel());
        try {
          const pdf = await pdfEngine().getDocument(docId, revision);
          if (mine !== sequence) return;
          const page = await pdf.getPage(pageIndex + 1);
          if (mine !== sequence) return;
          const { TextLayer: PdfTextLayer } = await import("pdfjs-dist");
          if (mine !== sequence) return;
          const viewport = page.getViewport({ scale: untrack(() => props.zoom) });
          const layerTask = new PdfTextLayer({
            textContentSource: page.streamTextContent(),
            container: layer,
            viewport,
          });
          task = layerTask;
          await layerTask.render();
          if (mine !== sequence) return;
          if (layer.querySelector("span")) {
            const end = document.createElement("div");
            end.className = "endOfContent";
            layer.append(end);
            return;
          }
          const lines = await invoke<OcrLine[] | null>("pdf_ocr_lines", {
            docId,
            expectedRevision: revision,
            pageIndex,
          });
          if (mine !== sequence) return;
          setOcrLines(lines ?? []);
        } catch (error) {
          if (mine !== sequence) return;
          if ((error as Error)?.name !== "AbortException")
            console.warn("text-layer render failed", error);
        }
      },
    ),
  );

  // `selecting` lets the endOfContent sentinel capture drags past the text.
  const startSelecting = () => layer.classList.add("selecting");
  const stopSelecting = () => layer.classList.remove("selecting");

  const match = () => {
    const selected = activeSearchMatch(),
      tab = activeTab();
    return selected &&
      tab?.tabId === selected.tabId &&
      tab.revision === selected.revision &&
      props.revision === selected.revision &&
      selected.hit.page === props.pageIndex
      ? selected
      : null;
  };

  const ocrSpans = createMemo(() =>
    ocrLines().map((line) => {
      const fontPts = line.h * props.page.height;
      const natural = naturalWidth(line.text, fontPts);
      const target = line.w * props.page.width;
      return {
        line,
        fontPts,
        scaleX: natural > 0 && target > 0 ? target / natural : 1,
      };
    }),
  );

  return (
    <>
      <Show when={match()}>
        <div
          class="search-mark-layer"
          aria-hidden="true"
          style={{
            width: `${props.page.width * props.zoom}px`,
            height: `${props.page.height * props.zoom}px`,
          }}
        >
          <For each={match()?.hit.rectangles ?? []}>
            {(rect, index) => (
              <span
                class="search-location-mark"
                ref={(el) => {
                  createEffect(() => {
                    const selected = match();
                    if (selected && index() === 0)
                      requestAnimationFrame(() => {
                        if (match() === selected)
                          el.scrollIntoView({
                            block: "nearest",
                            inline: "nearest",
                          });
                      });
                  });
                }}
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
              />
            )}
          </For>
        </div>
      </Show>
      <div
        ref={layer}
        class="textLayer"
        onPointerDown={startSelecting}
        onPointerUp={stopSelecting}
        onPointerLeave={stopSelecting}
      />
      <Show when={ocrSpans().length > 0}>
        <div
          class="ocr-text-layer"
          style={{
            "--scale-factor": props.zoom,
            "--total-scale-factor": props.zoom,
            width: `${props.page.width * props.zoom}px`,
            height: `${props.page.height * props.zoom}px`,
          }}
        >
          <For each={ocrSpans()}>
            {({ line, fontPts, scaleX }) => (
              <span
                class="ocr-text-line"
                style={{
                  left: `${line.x * 100}%`,
                  top: `${line.y * 100}%`,
                  "font-size": `calc(${fontPts}px * var(--total-scale-factor))`,
                  "line-height": `calc(${fontPts}px * var(--total-scale-factor))`,
                  transform: `scaleX(${scaleX})`,
                }}
              >
                {line.text}
              </span>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
