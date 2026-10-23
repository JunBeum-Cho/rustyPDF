// Pure helpers for the thumbnail sidebar (no DOM, no store imports).

/** `toIndex` for pdf_move_pages: the insertion index after the moved pages are
 * removed, given a drop slot (0..pageCount = "before page `slot`", in the
 * current order). Returns null when the drop would not change the order. */
export function moveToIndexFromSlot(
  indices: number[],
  slot: number,
  pageCount: number,
): number | null {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const clamped = Math.max(0, Math.min(pageCount, slot));
  const before = sorted.filter((i) => i < clamped).length;
  const toIndex = clamped - before;
  const contiguous = sorted.every((v, i) => v === sorted[0] + i);
  if (contiguous && toIndex === sorted[0]) return null;
  return toIndex;
}

/** Drop slot for a pointer position over a thumbnail: before it in its upper
 * half, after it in its lower half. */
export function dropSlotForPointer(
  index: number,
  pointerY: number,
  top: number,
  height: number,
): number {
  return pointerY < top + height / 2 ? index : index + 1;
}

/** Keep a context menu fully inside the viewport. */
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { x: number; y: number } {
  const maxX = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxY = Math.max(margin, viewportHeight - menuHeight - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}

export interface PageKeyContext {
  insideThumbnailSidebar: boolean;
  editableTarget: boolean;
  hasTextSelection: boolean;
  mod: boolean;
  key: string;
}

/** Whether a keydown should be handled as a page shortcut. */
export function shouldHandlePageKey(ctx: PageKeyContext): boolean {
  if (!ctx.insideThumbnailSidebar || ctx.editableTarget) return false;
  const key = ctx.key.toLowerCase();
  if (ctx.mod) {
    if ((key === "c" || key === "x") && ctx.hasTextSelection) return false;
    return key === "c" || key === "x" || key === "v" || key === "d";
  }
  return ctx.key === "Delete" || ctx.key === "Backspace";
}

/** Annotations on `indices`, re-indexed to 0..n-1 in the given order. */
export function reindexAnnotationsForPages<T extends { page: number }>(
  items: T[],
  indices: number[],
): T[] {
  const map = new Map<number, number>();
  indices.forEach((page, i) => map.set(page, i));
  return items
    .filter((a) => map.has(a.page))
    .map((a) => ({ ...a, page: map.get(a.page)! }));
}
