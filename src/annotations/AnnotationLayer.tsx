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
  updateAnnotationLive,
  updateAnnotationsLive,
} from "./store";
import type { Annotation, AnnotationKind, Point, Rect } from "./types";
import "./annotations.css";

interface AnnotationLayerProps {
  page: PageMeta;
  width: number;
  height: number;
  zoom: number;
  rotation: Rotation;
}

type Draft =
  | {
      type: Exclude<AnnotationKind, "text">;
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
    }
  | {
      mode: "resize";
      start: Point;
      id: string;
      original: Rect;
      handle: "nw" | "ne" | "sw" | "se";
    }
  | {
      mode: "endpoint";
      start: Point;
      id: string;
      originalPoints: Point[];
      pointIndex: number;
    }
  | null;

const MIN_SIZE = 4;

const styleForTool = (type: AnnotationKind) => {
  const common = {
    color: annotationStore.color,
    width: annotationStore.strokeWidth,
    fontSize: annotationStore.fontSize,
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

const annotationText = (annotation: Annotation) => annotation.payload?.text ?? "";

export function AnnotationLayer(props: AnnotationLayerProps) {
  const [draft, setDraft] = createSignal<Draft>(null);
  const [dragState, setDragState] = createSignal<DragState>(null);
  let layerRef: SVGSVGElement | undefined;

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
      type: tool,
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
    const point = eventToPagePoint(event);
    const delta = {
      x: point.x - currentDrag.start.x,
      y: point.y - currentDrag.start.y,
    };
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
      updateAnnotationLive(currentDrag.id, (annotation) => ({
        ...annotation,
        rect: resizeRect(currentDrag.original, currentDrag.handle, delta),
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
    if (dragState()) {
      setDragState(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const startMove = (event: PointerEvent, annotation: Annotation) => {
    if (event.button !== 0) {
      return;
    }
    // Clicking an existing annotation always selects/moves it, regardless of
    // which tool is active. Without stopPropagation the event bubbles to the
    // layer and starts a new draft on top of the annotation we just clicked.
    event.stopPropagation();
    const append = event.shiftKey || event.metaKey || event.ctrlKey;
    if (!selectedIds().has(annotation.id) || append) {
      selectAnnotation(annotation.id, append);
    }
    const ids = selectedIds().has(annotation.id) && !append ? annotationStore.selectedIds : [annotation.id];
    recordAnnotationHistory();
    setDragState({
      mode: "move",
      start: eventToPagePoint(event),
      ids,
      originals: annotationStore.items.filter((item) => ids.includes(item.id)),
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
    selectAnnotation(annotation.id);
    recordAnnotationHistory();
    setDragState({
      mode: "resize",
      start: eventToPagePoint(event),
      id: annotation.id,
      original: { ...annotation.rect },
      handle,
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
    selectAnnotation(annotation.id);
    recordAnnotationHistory();
    setDragState({
      mode: "endpoint",
      start: eventToPagePoint(event),
      id: annotation.id,
      originalPoints: annotation.points.map((p) => ({ ...p })),
      pointIndex,
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

  const finishTextEdit = (annotation: Annotation) => {
    if (annotationStore.editingId !== annotation.id) {
      return;
    }
    const text = annotationText(annotation);
    if (text.trim() === "") {
      // Empty text == implicit cancel: drop the annotation entirely. We pop
      // the history entry that addAnnotation pushed so it's not noise in undo.
      removeAnnotation(annotation.id, { record: false });
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
    const selected = selectedIds().has(annotation.id);
    const strokeWidth = Math.max(1, annotation.style.width * props.zoom);
    const shapeProps = {
      class: "annotation-shape",
      stroke: annotation.style.color,
      "stroke-width": strokeWidth,
      onPointerDown: (event: PointerEvent) => startMove(event, annotation),
      onDblClick: (event: MouseEvent) => editText(event, annotation),
    };

    if (annotation.type === "pen") {
      return (
        <path
          {...shapeProps}
          classList={{ selected }}
          d={displayPath(annotation.points, props.page, props.zoom, props.rotation)}
          fill="none"
        />
      );
    }

    if (annotation.type === "line" || annotation.type === "arrow") {
      const points = annotation.points ?? [];
      const start = pagePointToDisplay(points[0] ?? { x: 0, y: 0 }, props.page, props.zoom, props.rotation);
      const end = pagePointToDisplay(points[1] ?? { x: 0, y: 0 }, props.page, props.zoom, props.rotation);
      return (
        <line
          {...shapeProps}
          classList={{ selected }}
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
          marker-end={annotation.type === "arrow" ? "url(#annotation-arrow)" : undefined}
        />
      );
    }

    if (!annotation.rect) {
      return null;
    }
    const box = rectToDisplayBox(annotation.rect, props.page, props.zoom, props.rotation);
    if (annotation.type === "ellipse") {
      return (
        <ellipse
          {...shapeProps}
          classList={{ selected }}
          cx={box.x + box.w / 2}
          cy={box.y + box.h / 2}
          rx={box.w / 2}
          ry={box.h / 2}
          fill={annotation.style.fill ?? "none"}
          opacity={annotation.style.opacity ?? 1}
        />
      );
    }
    if (annotation.type === "text") {
      const isEditing = annotationStore.editingId === annotation.id;
      const fontSize = (annotation.style.fontSize ?? 16) * props.zoom;
      return (
        <foreignObject
          class="annotation-text-object"
          classList={{ selected, editing: isEditing }}
          x={box.x}
          y={box.y}
          width={Math.max(24, box.w)}
          height={Math.max(20, box.h)}
          onPointerDown={(event) => {
            if (isEditing) {
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
            when={isEditing}
            fallback={
              <div
                class="annotation-text"
                style={{
                  color: annotation.style.color,
                  "font-size": `${fontSize}px`,
                }}
              >
                {annotationText(annotation) || "텍스트"}
              </div>
            }
          >
            <textarea
              class="annotation-text-edit"
              style={{
                color: annotation.style.color,
                "font-size": `${fontSize}px`,
              }}
              ref={(el) => {
                if (!el) return;
                requestAnimationFrame(() => {
                  el.focus();
                  el.select();
                });
              }}
              value={annotationText(annotation)}
              placeholder="텍스트"
              onInput={(event) => {
                const text = event.currentTarget.value;
                updateAnnotationLive(annotation.id, (item) => ({
                  ...item,
                  payload: { ...item.payload, text },
                }));
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onBlur={() => finishTextEdit(annotation)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
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
        classList={{ selected }}
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
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
