import type { Rect } from "./types";

export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageFrameBox {
  pageIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
  pageWidthPt: number;
}

export interface PageQuads {
  pageIndex: number;
  quads: Rect[];
}

const GAP_PT = 2;

const sameLine = (a: Rect, b: Rect) => {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlap < 0.5 * Math.min(a.h, b.h)) return false;
  const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  return gap < GAP_PT;
};

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
};

export const selectionToQuads = (
  rects: ClientRectLike[],
  frames: PageFrameBox[],
): PageQuads[] => {
  const byPage = new Map<number, Rect[]>();
  for (const rect of rects) {
    if (!(rect.width > 0) || !(rect.height > 0)) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const frame = frames.find(
      (f) => cx >= f.left && cx <= f.left + f.width && cy >= f.top && cy <= f.top + f.height,
    );
    if (!frame || !(frame.width > 0) || !(frame.pageWidthPt > 0)) continue;
    const scale = frame.width / frame.pageWidthPt;
    const quad: Rect = {
      x: (rect.left - frame.left) / scale,
      y: (rect.top - frame.top) / scale,
      w: rect.width / scale,
      h: rect.height / scale,
    };
    const list = byPage.get(frame.pageIndex) ?? [];
    const idx = list.findIndex((q) => sameLine(q, quad));
    if (idx >= 0) list[idx] = union(list[idx], quad);
    else list.push(quad);
    byPage.set(frame.pageIndex, list);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, quads]) => ({ pageIndex, quads }));
};
