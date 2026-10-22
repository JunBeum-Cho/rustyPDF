import type { SearchHit, OcrLine } from "../ipc/pdf";

/** Match in Unicode scalar space, retaining each contributing line's bounds. */
export function searchLines(
  page: number,
  native: OcrLine[],
  ocr: OcrLine[],
  query: string,
): SearchHit[] {
  const nativeText = new Set(native.map((line) => line.text));
  const lines = [
    ...native.map((line) => ({ line, space: "raw" as const })),
    ...ocr
      .filter((line) => !nativeText.has(line.text))
      .map((line) => ({ line, space: "display" as const })),
  ];
  const text = lines.map(({ line }) => line.text).join("\n");
  // Fold one scalar at a time so expansions (İ → i + combining dot) do not
  // shift source offsets or the rectangles of subsequent matches.
  const scalars = Array.from(text),
    folded: string[] = [],
    offsets: number[] = [];
  scalars.forEach((char, index) => {
    for (const unit of char.toLocaleLowerCase()) {
      folded.push(unit);
      offsets.push(index);
    }
  });
  const lower = folded.join(""),
    needle = query.toLocaleLowerCase();
  if (!needle) return [];
  // JS indexOf addresses UTF-16, so retain a unit -> scalar map too.
  const unitOffsets = folded.flatMap((c, i) =>
    Array(c.length).fill(offsets[i]),
  );
  const result: SearchHit[] = [];
  for (let from = 0; from < lower.length;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    const start = unitOffsets[at],
      end = unitOffsets[at + needle.length - 1] + 1;
    let lineStart = 0;
    const rectangles: NonNullable<SearchHit["rectangles"]> = [];
    for (const { line, space } of lines) {
      const length = Array.from(line.text).length;
      const a = Math.max(start, lineStart),
        b = Math.min(end, lineStart + length);
      if (b > a)
        rectangles.push({
          x: line.x + (line.w * (a - lineStart)) / length,
          y: line.y,
          w: (line.w * (b - a)) / length,
          h: line.h,
          space,
        });
      lineStart += length + 1;
    }
    const space = rectangles[0]?.space ?? "raw";
    result.push({
      page,
      start,
      length: end - start,
      snippet: scalars.slice(Math.max(0, start - 40), end + 80).join(""),
      space,
      rectangles: rectangles.map(({ space: rectSpace, ...rect }) =>
        rectSpace === space ? rect : { ...rect, space: rectSpace },
      ),
    });
    from = at + Math.max(1, needle.length);
  }
  return result;
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
export function highlightGeometry(
  page: { width: number; height: number; rotation: number },
  zoom: number,
  rotation: number,
  space: "raw" | "display",
) {
  const swapped =
    space === "raw" && (page.rotation === 90 || page.rotation === 270);
  const width = (swapped ? page.height : page.width) * zoom,
    height = (swapped ? page.width : page.height) * zoom;
  const angle = ((space === "raw" ? page.rotation : 0) + rotation) % 360;
  const transform =
    angle === 90
      ? `translateX(${height}px) rotate(90deg)`
      : angle === 180
        ? `translate(${width}px, ${height}px) rotate(180deg)`
        : angle === 270
          ? `translateY(${width}px) rotate(270deg)`
          : "none";
  return { width, height, transform };
}
