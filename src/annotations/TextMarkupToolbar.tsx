import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { activeTab } from "../state/document";
import {
  addAnnotationToTab,
  annotationStore,
  createAnnotationId,
} from "./store";
import { selectionToQuads, type PageFrameBox } from "./textMarkup";
import type { Annotation, Rect } from "./types";

type MarkupType = "highlight" | "underline" | "strikeout";

const TEXT_LAYER = ".textLayer, .ocr-text-layer";

const elementOf = (node: Node | null): Element | null =>
  node instanceof Element ? node : (node?.parentElement ?? null);

const bbox = (quads: Rect[]): Rect => {
  const x = Math.min(...quads.map((q) => q.x));
  const y = Math.min(...quads.map((q) => q.y));
  return {
    x,
    y,
    w: Math.max(...quads.map((q) => q.x + q.w)) - x,
    h: Math.max(...quads.map((q) => q.y + q.h)) - y,
  };
};

const collectFrames = (): PageFrameBox[] => {
  const frames: PageFrameBox[] = [];
  document.querySelectorAll<HTMLElement>(".page-frame[data-page-index]").forEach((el) => {
    const box = el.getBoundingClientRect();
    const pageWidthPt = Number(el.dataset.pageWidth ?? "") ;
    frames.push({
      pageIndex: Number(el.dataset.pageIndex),
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      pageWidthPt: pageWidthPt > 0 ? pageWidthPt : (activeTab()?.pages?.[Number(el.dataset.pageIndex)]?.width ?? 0),
    });
  });
  return frames;
};

export function TextMarkupToolbar() {
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  let bar: HTMLDivElement | undefined;

  const update = () => {
    const tab = activeTab();
    const sel = window.getSelection();
    if (
      !tab ||
      tab.readOnly ||
      annotationStore.editingId ||
      !sel ||
      sel.isCollapsed ||
      sel.rangeCount === 0
    ) {
      setPos(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const a = elementOf(range.startContainer)?.closest(TEXT_LAYER);
    const b = elementOf(range.endContainer)?.closest(TEXT_LAYER);
    const common = elementOf(range.commonAncestorContainer);
    if (!(a && b) && !common?.closest(TEXT_LAYER)) {
      setPos(null);
      return;
    }
    const box = range.getBoundingClientRect();
    if (!box.width && !box.height) {
      setPos(null);
      return;
    }
    const w = bar?.offsetWidth || 180;
    const left = Math.min(Math.max(8, box.left + box.width / 2 - w / 2), window.innerWidth - w - 8);
    const top = Math.max(8, box.top - 40);
    setPos({ left, top });
  };

  const apply = (type: MarkupType) => {
    const tab = activeTab();
    const sel = window.getSelection();
    if (!tab || tab.readOnly || !sel || sel.rangeCount === 0) return;
    const rects = Array.from(sel.getRangeAt(0).getClientRects());
    const groups = selectionToQuads(rects, collectFrames());
    const color = annotationStore.color;
    for (const group of groups) {
      if (!group.quads.length) continue;
      const annotation: Annotation = {
        id: createAnnotationId(),
        page: group.pageIndex,
        type,
        rect: bbox(group.quads),
        quads: group.quads,
        style:
          type === "highlight"
            ? { color, fill: color, opacity: 0.32, width: 0 }
            : { color, width: 1 },
      };
      addAnnotationToTab(tab.tabId, annotation);
    }
    sel.removeAllRanges();
    setPos(null);
  };

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPos(null);
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("keydown", onKey);
    });
  });

  const button = (type: MarkupType, label: string) => (
    <button
      type="button"
      class="text-markup-button"
      onMouseDown={(event) => {
        event.preventDefault();
        apply(type);
      }}
    >
      {label}
    </button>
  );

  return (
    <Show when={pos()}>
      {(p) => (
        <div
          ref={bar}
          class="text-markup-toolbar"
          role="toolbar"
          aria-label="텍스트 마크업"
          style={{
            position: "fixed",
            left: `${p().left}px`,
            top: `${p().top}px`,
            "z-index": 1000,
            display: "flex",
            gap: "2px",
            padding: "4px",
            background: "var(--surface, #fff)",
            color: "var(--text, #222)",
            border: "1px solid var(--border, #ccc)",
            "border-radius": "6px",
            "box-shadow": "0 2px 8px rgba(0,0,0,.2)",
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {button("highlight", "형광펜")}
          {button("underline", "밑줄")}
          {button("strikeout", "취소선")}
        </div>
      )}
    </Show>
  );
}
