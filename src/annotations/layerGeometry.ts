import type { Point, Rect } from "./types";

/** Normalize a dragged page-point rect (top-left origin) to 0..1 of the page. */
export function normalizeCaptureRect(
  rect: Rect,
  page: { width: number; height: number },
): Rect | null {
  if (!(page.width > 0) || !(page.height > 0)) return null;
  const x0 = Math.max(0, Math.min(1, rect.x / page.width));
  const y0 = Math.max(0, Math.min(1, rect.y / page.height));
  const x1 = Math.max(0, Math.min(1, (rect.x + rect.w) / page.width));
  const y1 = Math.max(0, Math.min(1, (rect.y + rect.h) / page.height));
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const segDistance = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
  );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Ramer–Douglas–Peucker simplification (iterative, keeps endpoints). */
export function simplifyPoints(points: Point[], epsilon = 0.5): Point[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let best = -1;
    let bestDist = epsilon;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDistance(points[i], points[lo], points[hi]);
      if (d > bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([lo, best], [best, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export const moveQuads = (
  quads: Rect[] | undefined,
  delta: Point,
): Rect[] | undefined =>
  quads?.map((q) => ({ ...q, x: q.x + delta.x, y: q.y + delta.y }));

export function unionRect(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}
