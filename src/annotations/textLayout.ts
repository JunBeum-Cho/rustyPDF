import { contentBox } from "./coords";
import type { Annotation, TextLayoutFragment, TextLayoutLine } from "./types";
import { escapeAnnotationText, sanitizeAnnotationHtml } from "./sanitize";
// Measurement boxes are styled by `.annotation-text`, so the stylesheet has
// to be loaded even if the viewer never mounted.
import "./annotations.css";

/**
 * Markup the text annotation renders. Rich-text annotations carry `html`;
 * anything written before rich text (or imported from a v1 sidecar) only has
 * `text`, which we escape into equivalent markup.
 */
export const annotationHtml = (annotation: Annotation): string => {
  const html = annotation.payload?.html;
  if (html != null) return typeof html === "string" ? sanitizeAnnotationHtml(html) : "";
  const text = annotation.payload?.text ?? "";
  if (!text) return "";
  return escapeAnnotationText(text);
};

/**
 * Two fragments are on the same line when their baselines agree to within
 * this many points. Sub-pixel layout means exact equality is not safe even
 * for glyphs that visually share a baseline.
 */
const BASELINE_EPSILON = 0.5;

/** Used if the calibration probe can't be laid out for some reason. */
const FALLBACK_ASCENT_RATIO = 0.8;

/**
 * Cache of calibration results. Scoped to one measurement rather than the
 * module so a probe taken before a web font finished loading can never be
 * reused later.
 */
type BaselineCache = Map<string, number>;

/**
 * Distance from the top of a text run's client rect down to its baseline.
 *
 * Rather than assume what a browser's text rects mean — the font's content
 * box in some engines, the full line box in others — this calibrates against
 * the real thing: an empty zero-height inline-block sits with its bottom edge
 * exactly on the baseline, so the gap between it and a range rect over text
 * in the same line *is* the offset, whatever the engine's convention.
 */
const baselineOffset = (
  host: HTMLElement,
  computed: CSSStyleDeclaration,
  fontSize: number,
  cache: BaselineCache,
): number => {
  const key = [
    computed.fontStyle,
    computed.fontWeight,
    computed.fontFamily,
    computed.lineHeight,
    fontSize,
  ].join("|");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let offset = fontSize * FALLBACK_ASCENT_RATIO;
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.top = "0";
  probe.style.left = "0";
  probe.style.whiteSpace = "pre";
  probe.style.fontStyle = computed.fontStyle;
  probe.style.fontWeight = computed.fontWeight;
  probe.style.fontFamily = computed.fontFamily;
  probe.style.fontSize = `${fontSize}px`;
  probe.style.lineHeight = computed.lineHeight;
  const sample = document.createElement("span");
  sample.textContent = "Hg가";
  const anchor = document.createElement("span");
  anchor.style.display = "inline-block";
  anchor.style.width = "0";
  anchor.style.height = "0";
  anchor.style.overflow = "hidden";
  anchor.style.verticalAlign = "baseline";
  probe.append(sample, anchor);
  host.appendChild(probe);
  try {
    const sampleText = sample.firstChild;
    if (sampleText) {
      const range = document.createRange();
      range.selectNodeContents(sampleText);
      const top = range.getBoundingClientRect().top;
      const baseline = anchor.getBoundingClientRect().bottom;
      const measured = baseline - top;
      if (Number.isFinite(measured) && measured > 0) {
        offset = measured;
      }
    }
  } finally {
    probe.remove();
  }

  cache.set(key, offset);
  return offset;
};

const toHexColor = (value: string): string => {
  const match = value.match(/-?\d+(\.\d+)?/g);
  if (!match || match.length < 3) return "#000000";
  const channel = (raw: string) => {
    const n = Math.round(Number(raw));
    const clamped = Math.min(255, Math.max(0, Number.isFinite(n) ? n : 0));
    return clamped.toString(16).padStart(2, "0");
  };
  return `#${channel(match[0])}${channel(match[1])}${channel(match[2])}`;
};

const isBoldWeight = (weight: string): boolean => {
  const normalized = weight.trim().toLowerCase();
  if (normalized === "bold" || normalized === "bolder") return true;
  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) && numeric >= 600;
};

const isWhitespace = (char: string) => /\s/.test(char);

const MEASURE_HOST_ID = "annotation-text-measure-host";

/**
 * Off-screen host for measurement boxes. Kept out of the layout flow but
 * still laid out (`visibility: hidden`, not `display: none`) so client rects
 * are real.
 */
const measureHost = (): HTMLElement => {
  const existing = document.getElementById(MEASURE_HOST_ID);
  if (existing) return existing;
  const host = document.createElement("div");
  host.id = MEASURE_HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.position = "absolute";
  host.style.top = "0";
  host.style.left = "-100000px";
  host.style.width = "0";
  host.style.height = "0";
  host.style.overflow = "hidden";
  host.style.visibility = "hidden";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);
  return host;
};

const collectLines = (box: HTMLElement, host: HTMLElement): TextLayoutLine[] => {
  const baselines: BaselineCache = new Map();
  const origin = box.getBoundingClientRect();
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const lines: TextLayoutLine[] = [];

  const push = (baseline: number, fragment: TextLayoutFragment) => {
    const line = lines.find(
      (candidate) => Math.abs(candidate.baseline - baseline) <= BASELINE_EPSILON,
    );
    if (line) {
      line.fragments.push(fragment);
      return;
    }
    lines.push({ baseline, fragments: [fragment] });
  };

  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? "";
    const parent = node.parentElement;
    if (text.length > 0 && parent) {
      const computed = window.getComputedStyle(parent);
      const fontSize = Number.parseFloat(computed.fontSize) || 16;
      const fontFamily = computed.fontFamily;
      const ascent = baselineOffset(host, computed, fontSize, baselines);
      const shared = {
        fontSize,
        color: toHexColor(computed.color),
        fontFamily,
        bold: isBoldWeight(computed.fontWeight),
        italic:
          computed.fontStyle === "italic" || computed.fontStyle === "oblique",
        underline: (computed.textDecorationLine || computed.textDecoration || "")
          .includes("underline"),
      };

      // Walk character by character. A fragment ends when the baseline moves
      // (the line wrapped) or a new word starts — splitting on word
      // boundaries keeps each run anchored at its measured x, so the small
      // width differences between the screen font and the embedded PDF font
      // can never accumulate across a line.
      let start = -1;
      let baseline = 0;
      let left = 0;
      const flush = (end: number) => {
        if (start < 0) return;
        const value = text.slice(start, end);
        start = -1;
        if (value.length === 0) return;
        push(baseline, { text: value, x: left - origin.left, ...shared });
      };

      for (let i = 0; i < text.length; i += 1) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        // Whitespace collapsed away by a soft wrap has no box at all.
        if (rect.width === 0 && rect.height === 0) continue;
        const charBaseline = rect.top + ascent;
        const startsWord =
          i > 0 && isWhitespace(text[i - 1]) && !isWhitespace(text[i]);
        if (
          start < 0 ||
          startsWord ||
          Math.abs(charBaseline - baseline) > BASELINE_EPSILON
        ) {
          flush(i);
          start = i;
          baseline = charBaseline;
          left = rect.left;
        }
      }
      flush(text.length);
    }
    node = walker.nextNode();
  }

  for (const line of lines) {
    line.fragments.sort((a, b) => a.x - b.x);
    line.baseline -= origin.top;
  }
  lines.sort((a, b) => a.baseline - b.baseline);
  return lines;
};

/**
 * Lay a text annotation out exactly the way the editor does and report where
 * every run landed. The exporter draws from this, so wrapping, alignment,
 * padding and baselines match the screen by construction rather than by two
 * implementations agreeing on a formula.
 *
 * Measured at zoom 1, where one CSS pixel is one PDF point.
 */
export const measureTextLayout = (
  annotation: Annotation,
): TextLayoutLine[] | null => {
  if (annotation.type !== "text" || !annotation.rect) return null;
  const html = annotationHtml(annotation);
  if (!html.trim()) return null;

  const layoutRect = contentBox(annotation.rect, annotation.rotation ?? 0);
  const style = annotation.style;
  const box = document.createElement("div");
  box.className = "annotation-text";
  box.style.position = "absolute";
  box.style.top = "0";
  box.style.left = "0";
  // Mirrors the minimums AnnotationLayer applies to the rendered box, so the
  // measured wrap width is the wrap width the user saw.
  box.style.width = `${Math.max(24, layoutRect.w)}px`;
  box.style.minHeight = `${Math.max(20, layoutRect.h)}px`;
  box.style.color = style.color;
  box.style.fontSize = `${style.fontSize ?? 16}px`;
  box.style.fontFamily = style.fontFamily ?? "";
  box.style.fontWeight = style.fontWeight ?? "normal";
  box.style.fontStyle = style.fontStyle ?? "normal";
  box.style.textDecoration = style.textDecoration ?? "none";
  box.style.textAlign = style.textAlign ?? "left";
  box.innerHTML = html;

  const host = measureHost();
  host.appendChild(box);
  try {
    return collectLines(box, host);
  } catch (error) {
    console.error("measure text layout failed", error);
    return null;
  } finally {
    box.remove();
  }
};
