import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { PageMeta } from "../state/document";
import {
  displayPointToPage,
  displayedPageSize,
  movePoints,
  moveRect,
  normalizeRect,
  pagePointToDisplay,
  rectToDisplayBox,
  resizeRect,
  type Rotation,
} from "./coords";
import {
  addAnnotation,
  annotationStore,
  clearAnnotationSelection,
  createAnnotationId,
  recordAnnotationHistory,
  removeAnnotation,
  selectAnnotation,
  setAnnotationTool,
  startEditingAnnotation,
  stopEditingAnnotation,
  updateAnnotation,
  updateAnnotationLive,
  updateAnnotationsLive,
} from "./store";
import {
  readEditorStylePatch,
  registerEditor,
  unregisterEditor,
  type TextStylePatch,
} from "./textFormat";
import {
  captureRegion,
  copyPngToClipboard,
  emitToast,
  saveCaptureAs,
} from "../capture/capture";
import type { Annotation, AnnotationKind, Point, Rect } from "./types";
import "./annotations.css";

interface AnnotationLayerProps {
  page: PageMeta;
  width: number;
  height: number;
  zoom: number;
  rotation: Rotation;
}

type DraftKind = Exclude<AnnotationKind, "text"> | "capture";

type Draft =
  | {
      type: DraftKind;
      start: Point;
      current: Point;
      points: Point[];
    }
  | null;

type DragState =
  | {
      mode: "move";
      start: Point;
      ids: string[];
      originals: Annotation[];
      moved: boolean;
    }
  | {
      mode: "resize";
      start: Point;
      id: string;
      original: Rect;
      handle: "nw" | "ne" | "sw" | "se";
      moved: boolean;
    }
  | {
      mode: "endpoint";
      start: Point;
      id: string;
      originalPoints: Point[];
      pointIndex: number;
      moved: boolean;
    }
  | null;

// Pointer movement threshold (in PDF points) before a click promotes to a
// drag. Without this, a plain click ends up calling the move/resize updaters
// with a near-zero delta — that still produces a fresh annotation object
// reference, which forces <For> to remount the row and breaks both dblclick
// (target lost between the two clicks) and re-entry into edit mode.
const DRAG_THRESHOLD = 2;

const TEXT_DOUBLE_CLICK_MS = 500;
const TEXT_DOUBLE_CLICK_DISTANCE_PX = 8;

const MIN_SIZE = 4;

const styleForTool = (type: AnnotationKind) => {
  const common = {
    color: annotationStore.color,
    width: annotationStore.strokeWidth,
    fontSize: annotationStore.fontSize,
    fontFamily: annotationStore.fontFamily,
  };
  if (type === "highlight") {
    return {
      ...common,
      color: annotationStore.color,
      fill: annotationStore.color,
      opacity: 0.32,
      width: 0,
    };
  }
  if (type === "text") {
    return {
      ...common,
      width: 1,
      fill: "transparent",
    };
  }
  return common;
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const displayPath = (
  points: Point[] | undefined,
  page: PageMeta,
  zoom: number,
  rotation: Rotation,
) =>
  (points ?? [])
    .map((point) => pagePointToDisplay(point, page, zoom, rotation))
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

const annotationHtml = (annotation: Annotation) => {
  const html = annotation.payload?.html;
  if (html != null) return html;
  // Legacy fallback: plain text → escape and use as innerHTML.
  const text = annotation.payload?.text ?? "";
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
};

const htmlIsEmpty = (html: string) => {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent?.trim() === "";
};

const clearNativeTextSelection = () => {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    selection.removeAllRanges();
  }
};

const activeTextEditor = () => {
  const active = document.activeElement;
  return active instanceof HTMLElement &&
    active.classList.contains("annotation-text-edit")
    ? active
    : null;
};

const textStyleChanged = (
  annotation: Annotation,
  patch: TextStylePatch,
) =>
  (patch.color !== undefined && patch.color !== annotation.style.color) ||
  (patch.fontSize !== undefined &&
    patch.fontSize !== (annotation.style.fontSize ?? 16)) ||
  (patch.fontFamily !== undefined &&
    patch.fontFamily !== annotation.style.fontFamily);

export function AnnotationLayer(props: AnnotationLayerProps) {
  const [draft, setDraft] = createSignal<Draft>(null);
  const [dragState, setDragState] = createSignal<DragState>(null);
  let layerRef: SVGSVGElement | undefined;
  let lastTextClick:
    | { id: string; time: number; clientX: number; clientY: number }
    | null = null;

  const pageAnnotations = createMemo(() =>
    annotationStore.items.filter((annotation) => annotation.page === props.page.index),
  );

  const selectedIds = createMemo(() => new Set(annotationStore.selectedIds));
  const displaySize = createMemo(() => displayedPageSize(props.page, props.rotation));

  const eventToPagePoint = (event: PointerEvent | MouseEvent): Point => {
    const rect = layerRef?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return displayPointToPage(
      {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      },
      props.page,
      props.zoom,
      props.rotation,
    );
  };

  const buildAnnotation = (currentDraft: NonNullable<Draft>): Annotation | null => {
    const type = currentDraft.type;
    if (type === "capture") {
      // Capture is handled separately in pointerup — never produces an
      // annotation in the document.
      return null;
    }
    if (type === "pen") {
      if (currentDraft.points.length < 2) {
        return null;
      }
      return {
        id: createAnnotationId(),
        page: props.page.index,
        type,
        points: currentDraft.points,
        style: styleForTool(type),
      };
    }
    if (type === "line" || type === "arrow") {
      if (distance(currentDraft.start, currentDraft.current) < MIN_SIZE) {
        return null;
      }
      return {
        id: createAnnotationId(),
        page: props.page.index,
        type,
        points: [currentDraft.start, currentDraft.current],
        style: styleForTool(type),
      };
    }
    const rect = normalizeRect(currentDraft.start, currentDraft.current);
    if (rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
      return null;
    }
    return {
      id: createAnnotationId(),
      page: props.page.index,
      type,
      rect,
      style: styleForTool(type),
    };
  };

  const onLayerPointerDown: JSX.EventHandlerUnion<SVGSVGElement, PointerEvent> = (event) => {
    if (event.button !== 0) {
      return;
    }
    lastTextClick = null;
    if (annotationStore.editingId) {
      const editor = activeTextEditor();
      if (editor) {
        editor.blur();
      } else {
        stopEditingAnnotation();
      }
      clearAnnotationSelection();
      return;
    }
    // Clicking empty page area always clears the current selection — this
    // runs regardless of the active tool. Annotations call stopPropagation
    // in their own pointerdown so this only fires for the background.
    if (annotationStore.selectedIds.length > 0) {
      clearAnnotationSelection();
    }
    const tool = annotationStore.tool;
    if (tool === "select") {
      return;
    }
    const point = eventToPagePoint(event);
    if (tool === "text") {
      const id = createAnnotationId();
      addAnnotation({
        id,
        page: props.page.index,
        type: "text",
        rect: {
          x: point.x,
          y: point.y,
          w: 220,
          h: 56,
        },
        style: styleForTool("text"),
        payload: { text: "" },
      });
      setAnnotationTool("select");
      startEditingAnnotation(id);
      return;
    }
    setDraft({
      type: tool as DraftKind,
      start: point,
      current: point,
      points: [point],
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onLayerPointerMove: JSX.EventHandlerUnion<SVGSVGElement, PointerEvent> = (event) => {
    const currentDraft = draft();
    if (currentDraft) {
      const point = eventToPagePoint(event);
      if (currentDraft.type === "pen") {
        const points = currentDraft.points;
        const previous = points[points.length - 1];
        if (distance(previous, point) > 0.8) {
          setDraft({ ...currentDraft, current: point, points: [...points, point] });
        }
      } else {
        setDraft({ ...currentDraft, current: point });
      }
      return;
    }

    const currentDrag = dragState();
    if (!currentDrag) {
      return;
    }
    clearNativeTextSelection();
    const point = eventToPagePoint(event);
    const delta = {
      x: point.x - currentDrag.start.x,
      y: point.y - currentDrag.start.y,
    };
    // Promote to a real drag only after threshold — see DRAG_THRESHOLD comment.
    if (
      !currentDrag.moved &&
      Math.hypot(delta.x, delta.y) < DRAG_THRESHOLD
    ) {
      return;
    }
    if (!currentDrag.moved) {
      // Record a single history entry at the moment the drag actually
      // starts — not on every initial click.
      recordAnnotationHistory();
      setDragState({ ...currentDrag, moved: true });
    }
    if (currentDrag.mode === "move") {
      updateAnnotationsLive(currentDrag.ids, (annotation) => {
        const original = currentDrag.originals.find((item) => item.id === annotation.id);
        if (!original) {
          return annotation;
        }
        return {
          ...annotation,
          rect: original.rect ? moveRect(original.rect, delta) : annotation.rect,
          points: movePoints(original.points, delta),
        };
      });
    } else if (currentDrag.mode === "resize") {
      // Shift / Ctrl / Meta → preserve aspect ratio. Always-on for images
      // would feel right but other shape types (rectangle, ellipse) often
      // need free resize, so we gate on modifier keys uniformly.
      const preserveAspect =
        event.shiftKey || event.ctrlKey || event.metaKey;
      updateAnnotationLive(currentDrag.id, (annotation) => ({
        ...annotation,
        rect: resizeRect(
          currentDrag.original,
          currentDrag.handle,
          delta,
          preserveAspect,
        ),
      }));
    } else {
      updateAnnotationLive(currentDrag.id, (annotation) => {
        const points = currentDrag.originalPoints.map((p, i) =>
          i === currentDrag.pointIndex ? { x: p.x + delta.x, y: p.y + delta.y } : p,
        );
        return { ...annotation, points };
      });
    }
  };

  const onLayerPointerUp: JSX.EventHandlerUnion<SVGSVGElement, PointerEvent> = (event) => {
    const currentDraft = draft();
    if (currentDraft) {
      if (currentDraft.type === "capture") {
        const rect = normalizeRect(currentDraft.start, currentDraft.current);
        if (rect.w >= MIN_SIZE && rect.h >= MIN_SIZE) {
          const pngPromise = captureRegion({
            pageIndex: props.page.index,
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
          });

          pngPromise.then(
            (buf) => {
              emitToast("스크린샷이 준비됐습니다", "info", {
                timeoutMs: null,
                actions: [
                  {
                    label: "내 컴퓨터로 저장하기",
                    run: async () => {
                      const saved = await saveCaptureAs(buf);
                      if (saved) emitToast("스크린샷을 저장했습니다");
                    },
                  },
                  {
                    label: "클립보드에 복사하기",
                    run: async () => {
                      await copyPngToClipboard(buf);
                      emitToast("스크린샷이 클립보드에 복사됐습니다");
                    },
                  },
                ],
              });
            },
            (error) => {
              console.error("capture failed", error);
              emitToast(
                `캡처 실패: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            },
          );
        }
        setDraft(null);
        // Auto-revert to the select tool after a single capture so the user
        // doesn't accidentally re-enter capture mode on their next click.
        setAnnotationTool("select");
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        return;
      }
      const annotation = buildAnnotation(currentDraft);
      if (annotation) {
        addAnnotation(annotation);
      }
      setDraft(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    const currentDrag = dragState();
    if (currentDrag) {
      if (
        currentDrag.mode === "move" &&
        !currentDrag.moved &&
        currentDrag.ids.length === 1
      ) {
        const clicked = currentDrag.originals.find(
          (annotation) => annotation.id === currentDrag.ids[0],
        );
        if (clicked?.type === "text") {
          lastTextClick = {
            id: clicked.id,
            time: event.timeStamp || performance.now(),
            clientX: event.clientX,
            clientY: event.clientY,
          };
        } else {
          lastTextClick = null;
        }
      }
      setDragState(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const shouldEditTextFromPointerDown = (
    event: PointerEvent,
    annotation: Annotation,
  ) => {
    if (annotation.type !== "text") {
      lastTextClick = null;
      return false;
    }
    if (event.detail >= 2) {
      lastTextClick = null;
      return true;
    }
    const previous = lastTextClick;
    if (!previous || previous.id !== annotation.id) return false;
    const elapsed = (event.timeStamp || performance.now()) - previous.time;
    const moved = Math.hypot(
      event.clientX - previous.clientX,
      event.clientY - previous.clientY,
    );
    const isDoubleClick =
      elapsed <= TEXT_DOUBLE_CLICK_MS &&
      moved <= TEXT_DOUBLE_CLICK_DISTANCE_PX;
    if (isDoubleClick) lastTextClick = null;
    return isDoubleClick;
  };

  const startMove = (event: PointerEvent, annotation: Annotation) => {
    if (event.button !== 0) {
      return;
    }
    // Clicking an existing annotation always selects/moves it, regardless of
    // which tool is active. Without stopPropagation the event bubbles to the
    // layer and starts a new draft on top of the annotation we just clicked.
    event.stopPropagation();
    event.preventDefault();
    clearNativeTextSelection();
    if (shouldEditTextFromPointerDown(event, annotation)) {
      selectAnnotation(annotation.id);
      startEditingAnnotation(annotation.id);
      setDragState(null);
      return;
    }
    const append = event.shiftKey || event.metaKey || event.ctrlKey;
    if (!selectedIds().has(annotation.id) || append) {
      selectAnnotation(annotation.id, append);
    }
    const ids = selectedIds().has(annotation.id) && !append ? annotationStore.selectedIds : [annotation.id];
    // Don't push history for a plain click — only when the move actually
    // happens (in pointermove once threshold is exceeded). Otherwise every
    // click pollutes the undo stack with a noop.
    setDragState({
      mode: "move",
      start: eventToPagePoint(event),
      ids,
      originals: annotationStore.items.filter((item) => ids.includes(item.id)),
      moved: false,
    });
    layerRef?.setPointerCapture(event.pointerId);
  };

  const startResize = (
    event: PointerEvent,
    annotation: Annotation,
    handle: "nw" | "ne" | "sw" | "se",
  ) => {
    if (!annotation.rect) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    clearNativeTextSelection();
    selectAnnotation(annotation.id);
    setDragState({
      mode: "resize",
      start: eventToPagePoint(event),
      id: annotation.id,
      original: { ...annotation.rect },
      handle,
      moved: false,
    });
    layerRef?.setPointerCapture(event.pointerId);
  };

  const startEndpoint = (
    event: PointerEvent,
    annotation: Annotation,
    pointIndex: number,
  ) => {
    if (!annotation.points) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    clearNativeTextSelection();
    selectAnnotation(annotation.id);
    setDragState({
      mode: "endpoint",
      start: eventToPagePoint(event),
      id: annotation.id,
      originalPoints: annotation.points.map((p) => ({ ...p })),
      pointIndex,
      moved: false,
    });
    layerRef?.setPointerCapture(event.pointerId);
  };

  const editText = (event: MouseEvent, annotation: Annotation) => {
    if (annotation.type !== "text") {
      return;
    }
    event.stopPropagation();
    selectAnnotation(annotation.id);
    startEditingAnnotation(annotation.id);
  };

  const commitTextEdit = (
    annotation: Annotation,
    html: string,
    stylePatch: TextStylePatch = {},
  ) => {
    if (annotationStore.editingId !== annotation.id) {
      return;
    }
    if (htmlIsEmpty(html)) {
      // Empty content == implicit cancel: drop the annotation entirely. We
      // skip history because addAnnotation already pushed an entry — leaving
      // both would mean the user has to undo twice for an aborted text.
      removeAnnotation(annotation.id, { record: false });
    } else if (html !== annotationHtml(annotation) || textStyleChanged(annotation, stylePatch)) {
      // Derive a plain-text mirror so search and legacy consumers still work.
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const text = tmp.textContent ?? "";
      updateAnnotation(annotation.id, (item) => ({
        ...item,
        style: { ...item.style, ...stylePatch },
        payload: { ...item.payload, html, text },
      }));
    }
    stopEditingAnnotation();
  };

  const renderDraft = () => {
    const currentDraft = draft();
    if (!currentDraft) {
      return null;
    }
    const stroke = annotationStore.color;
    const width = Math.max(1, annotationStore.strokeWidth * props.zoom);
    if (currentDraft.type === "pen") {
      return (
        <path
          class="annotation-shape annotation-draft"
          d={displayPath(currentDraft.points, props.page, props.zoom, props.rotation)}
          fill="none"
          stroke={stroke}
          stroke-width={width}
        />
      );
    }
    if (currentDraft.type === "line" || currentDraft.type === "arrow") {
      const [start, end] = [currentDraft.start, currentDraft.current].map((point) =>
        pagePointToDisplay(point, props.page, props.zoom, props.rotation),
      );
      return (
        <line
          class="annotation-shape annotation-draft"
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
          stroke={stroke}
          stroke-width={width}
          marker-end={currentDraft.type === "arrow" ? "url(#annotation-arrow)" : undefined}
        />
      );
    }
    const box = rectToDisplayBox(
      normalizeRect(currentDraft.start, currentDraft.current),
      props.page,
      props.zoom,
      props.rotation,
    );
    if (currentDraft.type === "ellipse") {
      return (
        <ellipse
          class="annotation-shape annotation-draft"
          cx={box.x + box.w / 2}
          cy={box.y + box.h / 2}
          rx={box.w / 2}
          ry={box.h / 2}
          fill="none"
          stroke={stroke}
          stroke-width={width}
        />
      );
    }
    if (currentDraft.type === "capture") {
      return (
        <rect
          class="annotation-shape annotation-draft annotation-capture-draft"
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          fill="rgba(56, 132, 255, 0.12)"
          stroke="#3884ff"
          stroke-width={Math.max(1, props.zoom)}
        />
      );
    }
    return (
      <rect
        class="annotation-shape annotation-draft"
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill={currentDraft.type === "highlight" ? stroke : "none"}
        opacity={currentDraft.type === "highlight" ? 0.32 : 1}
        stroke={currentDraft.type === "highlight" ? "none" : stroke}
        stroke-width={width}
      />
    );
  };

  const renderAnnotation = (annotation: Annotation) => {
    // These need to stay reactive across the row's lifetime — capturing as
    // bare consts here would freeze them at first render, since Solid's <For>
    // only re-runs the callback when the item reference changes. So:
    // dbl-click-to-edit, click-to-select, and zoom-driven font size all
    // depend on these reading the latest store/prop values at access time.
    const selected = () => selectedIds().has(annotation.id);
    const isEditing = () => annotationStore.editingId === annotation.id;
    const fontSize = () => (annotation.style.fontSize ?? 16) * props.zoom;
    const strokeWidth = () => Math.max(1, annotation.style.width * props.zoom);
    const shapeProps = {
      class: "annotation-shape",
      stroke: annotation.style.color,
      get "stroke-width"() {
        return strokeWidth();
      },
      onPointerDown: (event: PointerEvent) => startMove(event, annotation),
      onDblClick: (event: MouseEvent) => editText(event, annotation),
    };

    if (annotation.type === "pen") {
      return (
        <path
          {...shapeProps}
          classList={{ selected: selected() }}
          d={displayPath(annotation.points, props.page, props.zoom, props.rotation)}
          fill="none"
        />
      );
    }

    if (annotation.type === "line" || annotation.type === "arrow") {
      const points = annotation.points ?? [];
      const start = () =>
        pagePointToDisplay(points[0] ?? { x: 0, y: 0 }, props.page, props.zoom, props.rotation);
      const end = () =>
        pagePointToDisplay(points[1] ?? { x: 0, y: 0 }, props.page, props.zoom, props.rotation);
      return (
        <line
          {...shapeProps}
          classList={{ selected: selected() }}
          x1={start().x}
          y1={start().y}
          x2={end().x}
          y2={end().y}
          marker-end={annotation.type === "arrow" ? "url(#annotation-arrow)" : undefined}
        />
      );
    }

    if (!annotation.rect) {
      return null;
    }
    const box = () =>
      rectToDisplayBox(annotation.rect!, props.page, props.zoom, props.rotation);
    if (annotation.type === "image") {
      return (
        <image
          class="annotation-shape annotation-image"
          classList={{ selected: selected() }}
          x={box().x}
          y={box().y}
          width={box().w}
          height={box().h}
          href={annotation.payload?.imageSrc ?? ""}
          preserveAspectRatio="none"
          onPointerDown={(event) => startMove(event, annotation)}
        />
      );
    }
    if (annotation.type === "ellipse") {
      return (
        <ellipse
          {...shapeProps}
          classList={{ selected: selected() }}
          cx={box().x + box().w / 2}
          cy={box().y + box().h / 2}
          rx={box().w / 2}
          ry={box().h / 2}
          fill={annotation.style.fill ?? "none"}
          opacity={annotation.style.opacity ?? 1}
        />
      );
    }
    if (annotation.type === "text") {
      return (
        <foreignObject
          class="annotation-text-object"
          classList={{ selected: selected(), editing: isEditing() }}
          x={box().x}
          y={box().y}
          width={Math.max(24, box().w)}
          height={Math.max(20, box().h)}
          onPointerDown={(event) => {
            if (isEditing()) {
              // Allow normal text-selection / caret placement inside the
              // textarea — don't kick into a move drag.
              event.stopPropagation();
              return;
            }
            startMove(event, annotation);
          }}
          onDblClick={(event) => editText(event, annotation)}
        >
          <Show
            when={isEditing()}
            fallback={
              <div
                class="annotation-text"
                style={{
                  color: annotation.style.color,
                  "font-size": `${fontSize()}px`,
                  "font-family": annotation.style.fontFamily ?? "inherit",
                  "font-weight": annotation.style.fontWeight ?? "normal",
                  "font-style": annotation.style.fontStyle ?? "normal",
                  "text-decoration": annotation.style.textDecoration ?? "none",
                  "text-align": annotation.style.textAlign ?? "left",
                }}
                // innerHTML so existing rich-text styling round-trips. The
                // empty-state placeholder is rendered via CSS ::before when
                // the annotation has no content yet.
                innerHTML={annotationHtml(annotation) || ""}
                attr:data-empty={annotationHtml(annotation) ? null : ""}
              />
            }
          >
            <div
              class="annotation-text-edit"
              style={{
                color: annotation.style.color,
                "font-size": `${fontSize()}px`,
                "font-family": annotation.style.fontFamily ?? "inherit",
                "font-weight": annotation.style.fontWeight ?? "normal",
                "font-style": annotation.style.fontStyle ?? "normal",
                "text-decoration": annotation.style.textDecoration ?? "none",
                "text-align": annotation.style.textAlign ?? "left",
              }}
              attr:data-annotation-zoom={props.zoom}
              ref={(el) => {
                if (!el) return;
                // Uncontrolled by design — we seed innerHTML once and let
                // execCommand / Selection drive subsequent edits. Re-binding
                // innerHTML on every keystroke would blow away the caret.
                el.innerHTML = annotationHtml(annotation);
                el.dataset.annotationColor = annotation.style.color;
                el.dataset.annotationFontSize = String(annotation.style.fontSize ?? 16);
                if (annotation.style.fontFamily) {
                  el.dataset.annotationFontFamily = annotation.style.fontFamily;
                } else {
                  delete el.dataset.annotationFontFamily;
                }
                registerEditor(el);
                requestAnimationFrame(() => {
                  el.focus();
                  // Drop a caret at the end so additive typing is natural.
                  const sel = window.getSelection();
                  if (sel) {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    range.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(range);
                  }
                });
              }}
              contenteditable
              spellcheck={false}
              onPointerDown={(event) => event.stopPropagation()}
              onFocus={(event) => registerEditor(event.currentTarget)}
              onBlur={(event) => {
                const html = event.currentTarget.innerHTML;
                const stylePatch = readEditorStylePatch(event.currentTarget);
                unregisterEditor(event.currentTarget);
                commitTextEdit(annotation, html, stylePatch);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey)
                ) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </Show>
        </foreignObject>
      );
    }
    return (
      <rect
        {...shapeProps}
        classList={{ selected: selected() }}
        x={box().x}
        y={box().y}
        width={box().w}
        height={box().h}
        fill={annotation.style.fill ?? "none"}
        opacity={annotation.style.opacity ?? 1}
      />
    );
  };

  const renderHandles = (annotation: Annotation) => {
    if (!selectedIds().has(annotation.id)) {
      return null;
    }
    if (annotation.rect) {
      const box = rectToDisplayBox(annotation.rect, props.page, props.zoom, props.rotation);
      const handles: Array<["nw" | "ne" | "sw" | "se", number, number]> = [
        ["nw", box.x, box.y],
        ["ne", box.x + box.w, box.y],
        ["sw", box.x, box.y + box.h],
        ["se", box.x + box.w, box.y + box.h],
      ];
      return (
        <For each={handles}>
          {([handle, x, y]) => (
            <rect
              class="annotation-handle"
              classList={{ [`handle-${handle}`]: true }}
              x={x - 5}
              y={y - 5}
              width="10"
              height="10"
              onPointerDown={(event) => startResize(event, annotation, handle)}
            />
          )}
        </For>
      );
    }
    if ((annotation.type === "line" || annotation.type === "arrow") && annotation.points) {
      return (
        <For each={annotation.points}>
          {(pt, i) => {
            const display = pagePointToDisplay(pt, props.page, props.zoom, props.rotation);
            return (
              <rect
                class="annotation-handle handle-endpoint"
                x={display.x - 5}
                y={display.y - 5}
                width="10"
                height="10"
                onPointerDown={(event) => startEndpoint(event, annotation, i())}
              />
            );
          }}
        </For>
      );
    }
    if (annotation.type === "pen" && annotation.points && annotation.points.length > 0) {
      const xs = annotation.points.map((p) => p.x);
      const ys = annotation.points.map((p) => p.y);
      const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: 0, h: 0 };
      bbox.w = Math.max(...xs) - bbox.x;
      bbox.h = Math.max(...ys) - bbox.y;
      const box = rectToDisplayBox(bbox, props.page, props.zoom, props.rotation);
      return (
        <rect
          class="annotation-bbox"
          x={box.x - 2}
          y={box.y - 2}
          width={box.w + 4}
          height={box.h + 4}
          fill="none"
        />
      );
    }
    return null;
  };

  return (
    <svg
      ref={layerRef}
      class="annotation-layer"
      // In "select" mode the user expects empty areas of the page to be
      // "transparent" to clicks so they can drag-select the text layer
      // below. Drawing tools (text/highlight/rect/...) need the SVG to
      // catch pointer events on empty areas, so we toggle a class instead
      // of always intercepting. Annotation shapes themselves always keep
      // pointer-events on so click-to-select still works in select mode.
      classList={{
        "passes-through":
          annotationStore.tool === "select" &&
          annotationStore.editingId === null &&
          dragState() === null &&
          draft() === null,
      }}
      width={props.width}
      height={props.height}
      viewBox={`0 0 ${displaySize().width * props.zoom} ${displaySize().height * props.zoom}`}
      onPointerDown={onLayerPointerDown}
      onPointerMove={onLayerPointerMove}
      onPointerUp={onLayerPointerUp}
      onPointerCancel={onLayerPointerUp}
    >
      <defs>
        <marker
          id="annotation-arrow"
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L9,3 z" fill={annotationStore.color} />
        </marker>
      </defs>
      <For each={pageAnnotations()}>{(annotation) => renderAnnotation(annotation)}</For>
      <For each={pageAnnotations()}>{(annotation) => <Show when={selectedIds().has(annotation.id)}>{renderHandles(annotation)}</Show>}</For>
      {renderDraft()}
    </svg>
  );
}
