import type { PageMeta } from "../state/document";
import type { Point, Rect } from "./types";

export type Rotation = 0 | 90 | 180 | 270;

export const displayedPageSize = (page: PageMeta, rotation: Rotation) => {
  if (rotation === 90 || rotation === 270) {
    return { width: page.height, height: page.width };
  }
  return { width: page.width, height: page.height };
};

export const pagePointToDisplay = (
  point: Point,
  page: PageMeta,
  zoom: number,
  rotation: Rotation,
): Point => {
  let display: Point;
  switch (rotation) {
    case 90:
      display = { x: page.height - point.y, y: point.x };
      break;
    case 180:
      display = { x: page.width - point.x, y: page.height - point.y };
      break;
    case 270:
      display = { x: point.y, y: page.width - point.x };
      break;
    default:
      display = point;
      break;
  }
  return { x: display.x * zoom, y: display.y * zoom };
};

export const displayPointToPage = (
  point: Point,
  page: PageMeta,
  zoom: number,
  rotation: Rotation,
): Point => {
  const x = point.x / zoom;
  const y = point.y / zoom;
  switch (rotation) {
    case 90:
      return { x: y, y: page.height - x };
    case 180:
      return { x: page.width - x, y: page.height - y };
    case 270:
      return { x: page.width - y, y: x };
    default:
      return { x, y };
  }
};

export const rectToDisplayBox = (
  rect: Rect,
  page: PageMeta,
  zoom: number,
  rotation: Rotation,
): Rect => {
  const points = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ].map((point) => pagePointToDisplay(point, page, zoom, rotation));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX,
    h: Math.max(...ys) - minY,
  };
};

export const normalizeRect = (a: Point, b: Point): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
};

export const moveRect = (rect: Rect, delta: Point): Rect => ({
  x: rect.x + delta.x,
  y: rect.y + delta.y,
  w: rect.w,
  h: rect.h,
});

export const resizeRect = (
  rect: Rect,
  handle: "nw" | "ne" | "sw" | "se",
  delta: Point,
  /**
   * When true, preserve the original rect's aspect ratio. The dragged corner
   * still goes where the cursor is on its dominant axis; the other axis is
   * slaved to keep w/h constant. This matches how Photoshop / Figma /
   * Keynote behave with Shift+drag on image handles.
   */
  preserveAspect = false,
): Rect => {
  let dx = delta.x;
  let dy = delta.y;
  if (preserveAspect && rect.w > 0 && rect.h > 0) {
    const aspect = rect.h / rect.w;
    const xSign = handle.includes("w") ? -1 : 1;
    const ySign = handle.includes("n") ? -1 : 1;
    const newW = rect.w + xSign * dx;
    const newH = rect.h + ySign * dy;
    // Pick whichever axis the user pulled further (relative to the rect's
    // own dimensions) and slave the other to it. Without this comparison,
    // small horizontal jitter would jump the height around or vice versa.
    if (Math.abs(newW - rect.w) * aspect >= Math.abs(newH - rect.h)) {
      const targetH = newW * aspect;
      dy = ySign * (targetH - rect.h);
    } else {
      const targetW = newH / aspect;
      dx = xSign * (targetW - rect.w);
    }
  }
  const left = handle.includes("w") ? rect.x + dx : rect.x;
  const right = handle.includes("e") ? rect.x + rect.w + dx : rect.x + rect.w;
  const top = handle.includes("n") ? rect.y + dy : rect.y;
  const bottom = handle.includes("s") ? rect.y + rect.h + dy : rect.y + rect.h;
  return normalizeRect({ x: left, y: top }, { x: right, y: bottom });
};

export const movePoints = (points: Point[] | undefined, delta: Point) =>
  points?.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
