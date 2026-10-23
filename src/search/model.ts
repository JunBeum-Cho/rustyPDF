import type { SearchHit, OcrLine } from "../ipc/pdf";

/** Rectangle in normalized page display space (0..1, top-left origin). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface TextItem {
  str: string;
  hasEOL?: boolean;
  rect: Rect;
}
export interface PageText {
  /** Items joined like PDF.js: strings concatenated, "\n" after hasEOL. */
  text: string;
  /** One entry per Unicode scalar of `text`; null for synthetic newlines. */
  chars: ({ rect: Rect; item: number; index: number; count: number } | null)[];
}

export function buildPageText(items: TextItem[]): PageText {
  let text = "";
  const chars: PageText["chars"] = [];
  items.forEach((item, item_) => {
    const scalars = Array.from(item.str);
    scalars.forEach((char, index) => {
      text += char;
      chars.push({ rect: item.rect, item: item_, index, count: scalars.length });
    });
    if (item.hasEOL) {
      text += "\n";
      chars.push(null);
    }
  });
  return { text, chars };
}

export const ocrLinesToItems = (lines: OcrLine[]): TextItem[] =>
  lines.map((line) => ({
    str: line.text,
    hasEOL: true,
    rect: { x: line.x, y: line.y, w: line.w, h: line.h },
  }));

/** OCR lines are joined with "\n" (no trailing newline). */
export const buildOcrText = (lines: OcrLine[]): PageText => {
  const items = ocrLinesToItems(lines);
  if (items.length) items[items.length - 1].hasEOL = false;
  return buildPageText(items);
};

const isSpace = (char: string) => /^\s$/u.test(char);

/** Fold one scalar at a time so expansions never shift source offsets. */
function foldScalars(scalars: string[], skipSpace: boolean) {
  const folded: string[] = [],
    source: number[] = [];
  scalars.forEach((char, index) => {
    if (skipSpace && isSpace(char)) return;
    for (const unit of char.toLocaleLowerCase()) {
      folded.push(unit);
      source.push(index);
    }
  });
  return { folded, source };
}

/** Find `query` in page text, ignoring all whitespace differences. */
export function searchPageText(
  page: number,
  pageText: PageText,
  query: string,
): SearchHit[] {
  const needle = foldScalars(Array.from(query), true).folded.join("");
  if (!needle) return [];
  const scalars = Array.from(pageText.text);
  const { folded, source } = foldScalars(scalars, true);
  const haystack = folded.join("");
  // indexOf addresses UTF-16 units; map each unit to its folded-array index.
  const unitToFolded: number[] = [];
  folded.forEach((unit, i) => {
    for (let k = 0; k < unit.length; k++) unitToFolded.push(i);
  });
  const hits: SearchHit[] = [];
  for (let from = 0; from < haystack.length; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const start = source[unitToFolded[at]],
      end = source[unitToFolded[at + needle.length - 1]] + 1;
    hits.push({
      page,
      start,
      length: end - start,
      snippet: scalars
        .slice(Math.max(0, start - 40), end + 80)
        .join("")
        .replace(/\s+/g, " "),
      rectangles: hitRects(pageText, start, end),
    });
    from = at + Math.max(1, needle.length);
  }
  return hits;
}

/** One rectangle per source item the match touches (covering matched chars). */
function hitRects(pageText: PageText, start: number, end: number): Rect[] {
  const scalars = Array.from(pageText.text);
  const byItem = new Map<number, { rect: Rect; a: number; b: number; count: number }>();
  for (let i = start; i < end; i++) {
    const c = pageText.chars[i];
    if (!c || isSpace(scalars[i])) continue;
    const entry = byItem.get(c.item);
    if (entry) entry.b = c.index + 1;
    else byItem.set(c.item, { rect: c.rect, a: c.index, b: c.index + 1, count: c.count });
  }
  return [...byItem.values()].map(({ rect, a, b, count }) => ({
    x: rect.x + (rect.w * a) / count,
    y: rect.y,
    w: (rect.w * (b - a)) / count,
    h: rect.h,
  }));
}

/** Normalized bounding box of a PDF.js text item under a viewport. */
export function itemRect(
  item: { transform: number[]; width: number; height: number },
  viewport: { transform: number[]; width: number; height: number },
): Rect {
  const [va, vb, vc, vd, ve, vf] = viewport.transform;
  const [ia, ib, ic, id, ie, iff] = item.transform;
  // item -> viewport pixels
  const a = va * ia + vc * ib,
    b = vb * ia + vd * ib,
    c = va * ic + vc * id,
    d = vb * ic + vd * id,
    e = va * ie + vc * iff + ve,
    f = vb * ie + vd * iff + vf;
  const scale = Math.hypot(va, vb) || 1;
  const w = item.width * scale,
    h = item.height * scale;
  const ul = Math.hypot(a, b) || 1,
    vl = Math.hypot(c, d) || 1;
  const ux = (a / ul) * w,
    uy = (b / ul) * w,
    vx = (c / vl) * h,
    vy = (d / vl) * h;
  const xs = [e, e + ux, e + vx, e + ux + vx],
    ys = [f, f + uy, f + vy, f + uy + vy];
  const minX = Math.min(...xs),
    minY = Math.min(...ys);
  return {
    x: minX / viewport.width,
    y: minY / viewport.height,
    w: (Math.max(...xs) - minX) / viewport.width,
    h: (Math.max(...ys) - minY) / viewport.height,
  };
}

/**
 * Replace hits of `redoPages` with `incoming`, keeping order by page/start
 * and the active match (same page + start) if it survives.
 */
export function mergeSearchHits(
  existing: SearchHit[],
  incoming: SearchHit[],
  redoPages: Iterable<number>,
  activeIndex: number,
) {
  const redo = new Set(redoPages);
  const active = existing[activeIndex];
  const hits = [...existing.filter((hit) => !redo.has(hit.page)), ...incoming].sort(
    (x, y) => x.page - y.page || x.start - y.start,
  );
  const index = active
    ? hits.findIndex((hit) => hit.page === active.page && hit.start === active.start)
    : -1;
  return { hits, activeIndex: index };
}

export function nextSearchIndex(
  current: number,
  direction: number,
  count: number,
) {
  return count === 0
    ? -1
    : current < 0
      ? 0
      : (((current + direction) % count) + count) % count;
}
