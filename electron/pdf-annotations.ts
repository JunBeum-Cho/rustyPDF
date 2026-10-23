import fontkit from "@pdf-lib/fontkit";
import { deflateSync, inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  PDFPage,
  PDFRef,
  PDFStream,
  type PDFFont,
  type PDFImage,
} from "pdf-lib";
import { ANNOTATION_FONT_FEATURES, fontFileName, normalizeFontFamily } from "../src/annotations/fonts.js";
import type { Annotation, AnnotationSidecar, Point, Rect } from "../src/annotations/types.js";
import { loadFontBytes, subsetFontBytes } from "./font-subset.js";

export type { Annotation };

const RUSTY_KEY = PDFName.of("RustyPDF");
const NAME_PREFIX = "rustypdf-";

export interface FontProvider {
  get(family?: string | null, bold?: boolean): Promise<PDFFont>;
}

type Matrix = [number, number, number, number, number, number];

/** Collect every character an annotation may draw, so one subset covers it. */
export function annotationText(a: Annotation): string {
  const parts: string[] = [];
  const layout = a.payload?.layout;
  if (Array.isArray(layout) && layout.length) {
    for (const line of layout)
      for (const f of line?.fragments ?? []) if (typeof f?.text === "string") parts.push(f.text);
  } else parts.push(fallbackText(a));
  return parts.join("");
}

function fallbackText(a: Annotation): string {
  if (typeof a.payload?.text === "string" && a.payload.text) return a.payload.text;
  const html = a.payload?.html;
  if (typeof html !== "string") return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\n$/, "");
}

/** Lazily embeds one harfbuzz subset per family/weight covering `text` plus a space. */
export function createFontProvider(pdf: PDFDocument, text: string, fontsDir?: string): FontProvider {
  const cache = new Map<string, Promise<PDFFont>>();
  const covered = " " + text;
  return {
    get(family, bold = false) {
      const file = fontFileName(family, bold);
      let font = cache.get(file);
      if (!font) {
        pdf.registerFontkit(fontkit);
        font = (async () => {
          const bytes = await subsetFontBytes(await loadFontBytes(file, fontsDir), covered);
          return pdf.embedFont(bytes, { subset: false, features: ANNOTATION_FONT_FEATURES });
        })();
        cache.set(file, font);
      }
      return font;
    },
  };
}

// ---------------------------------------------------------------- geometry

/** Display (top-left origin, rotated) points -> page user space. */
export function pageMatrix(page: PDFPage): Matrix {
  const box = page.getCropBox();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const m: Record<number, Matrix> = {
    0: [1, 0, 0, -1, box.x, box.y + box.height],
    90: [0, 1, 1, 0, box.x, box.y],
    180: [-1, 0, 0, 1, box.x + box.width, box.y],
    270: [0, -1, -1, 0, box.x + box.width, box.y + box.height],
  };
  if (!m[r]) throw new Error("Invalid page rotation");
  return m[r];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

const num = (v: number) => {
  const s = (Math.round(v * 10000) / 10000).toString();
  return s.includes("e") ? v.toFixed(6) : s;
};

function finite(...values: number[]) {
  if (!values.every(Number.isFinite)) throw new Error("Invalid annotation geometry");
}

function rgbOf(hex: string | undefined): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  const n = parseInt(m?.[1] ?? "000000", 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const rgbOps = (hex: string | undefined, op: "rg" | "RG") => `${rgbOf(hex).map(num).join(" ")} ${op}`;
const hasFill = (fill?: string) => !!fill && fill !== "transparent" && fill !== "none";
const isMarkup = (t: string) => t === "highlight" || t === "underline" || t === "strikeout";

function markupQuads(a: Annotation): Rect[] {
  if (a.quads?.length) return a.quads;
  return a.rect ? [a.rect] : [];
}

function checkGeometry(a: Annotation) {
  if (a.rect) finite(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
  for (const p of a.points ?? []) finite(p.x, p.y);
  for (const q of a.quads ?? []) finite(q.x, q.y, q.w, q.h);
}

/** Bounding box in display coordinates, including stroke padding. null when there is nothing to draw. */
function displayBounds(a: Annotation): Rect | null {
  const width = Math.max(0, a.style?.width ?? 1);
  let b: [number, number, number, number] | null = null;
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    b = b ? [Math.min(b[0], x1), Math.min(b[1], y1), Math.max(b[2], x2), Math.max(b[3], y2)] : [x1, y1, x2, y2];
  };
  const pad = (r: Rect, p: number) => add(r.x - p, r.y - p, r.x + r.w + p, r.y + r.h + p);
  if (a.type === "text" || a.type === "image") {
    if (a.rect) {
      pad(a.rect, 2);
      if (a.rotation === 90 || a.rotation === 270) {
        const cx = a.rect.x + a.rect.w / 2, cy = a.rect.y + a.rect.h / 2;
        add(cx - a.rect.h / 2 - 2, cy - a.rect.w / 2 - 2, cx + a.rect.h / 2 + 2, cy + a.rect.w / 2 + 2);
      }
    }
  } else if (isMarkup(a.type)) {
    for (const q of markupQuads(a)) pad(q, a.type === "highlight" ? 0 : Math.max(0.5, 0.07 * q.h));
  } else if (a.type === "rect" || a.type === "ellipse") {
    if (a.rect) pad(a.rect, width / 2 + 1);
  } else if (a.points?.length) {
    const p = width / 2 + 1 + (a.type === "arrow" ? 9 * width : 0);
    for (const pt of a.points) add(pt.x - p, pt.y - p, pt.x + p, pt.y + p);
  }
  if (!b) return null;
  const [x1, y1, x2, y2] = b as [number, number, number, number];
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function userBounds(m: Matrix, r: Rect): [number, number, number, number] {
  const pts = [apply(m, r.x, r.y), apply(m, r.x + r.w, r.y), apply(m, r.x, r.y + r.h), apply(m, r.x + r.w, r.y + r.h)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// -------------------------------------------------------------- appearance

export interface Appearance {
  /** Form XObject, or undefined when the annotation has nothing to draw. */
  ref?: PDFRef;
  /** Annotation bounds in page user space. */
  bbox: [number, number, number, number];
}

const imageCaches = new WeakMap<PDFDocument, Map<string, PDFImage>>();

async function embedImage(pdf: PDFDocument, source: string): Promise<PDFImage> {
  if (!/^data:image\/(png|jpe?g);base64,/i.test(source))
    throw new Error("Export image must be normalized PNG or JPEG data URL");
  let cache = imageCaches.get(pdf);
  if (!cache) imageCaches.set(pdf, (cache = new Map()));
  let image = cache.get(source);
  if (!image) {
    const raw = new Uint8Array(Buffer.from(source.slice(source.indexOf(",") + 1), "base64"));
    image = /^data:image\/png/i.test(source) ? await pdf.embedPng(raw) : await pdf.embedJpg(raw);
    cache.set(source, image);
  }
  return image;
}

function withResources() {
  const fonts = new Map<string, PDFRef>();
  const xobjects = new Map<string, PDFRef>();
  return {
    fonts,
    xobjects,
    font(font: PDFFont) {
      for (const [k, v] of fonts) if (v === font.ref) return k;
      const key = `F${fonts.size}`;
      fonts.set(key, font.ref);
      return key;
    },
    xobject(ref: PDFRef) {
      for (const [k, v] of xobjects) if (v === ref) return k;
      const key = `Im${xobjects.size}`;
      xobjects.set(key, ref);
      return key;
    },
  };
}

async function textOps(
  a: Annotation,
  rect: Rect,
  fonts: FontProvider,
  res: ReturnType<typeof withResources>,
): Promise<string[]> {
  const style = a.style ?? { color: "#000000", width: 1 };
  const out: string[] = [];
  const angle = ((a.rotation ?? 0) * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
  const swap = a.rotation === 90 || a.rotation === 270;
  out.push("q", `1 0 0 1 ${num(rect.x + rect.w / 2)} ${num(rect.y + rect.h / 2)} cm`);
  out.push(`${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(-(swap ? rect.h : rect.w) / 2)} ${num(-(swap ? rect.w : rect.h) / 2)} cm`);
  const layout = a.payload?.layout;
  const size0 = style.fontSize ?? 16;
  const lines =
    Array.isArray(layout) && layout.length
      ? layout
      : fallbackText(a).split("\n").map((text, i) => ({
          baseline: size0 * (1 + 1.2 * i),
          fragments: [{
            text, x: 0, fontSize: size0, color: style.color,
            fontFamily: normalizeFontFamily(style.fontFamily),
            bold: style.fontWeight === "bold" || Number(style.fontWeight) >= 600,
            italic: style.fontStyle === "italic" || !!style.fontStyle?.startsWith("oblique"),
            underline: style.textDecoration === "underline",
          }],
        }));
  for (const line of lines) {
    finite(line.baseline);
    if (!Array.isArray(line.fragments)) throw new Error("Invalid text layout");
    for (const f of line.fragments) {
      finite(f.x, f.fontSize);
      if (typeof f.text !== "string" || f.fontSize <= 0) throw new Error("Invalid text fragment");
      const font = await fonts.get(f.fontFamily ?? style.fontFamily, !!f.bold);
      const key = res.font(font);
      const col = f.color ?? style.color;
      out.push("q", `1 0 0 -1 ${num(f.x)} ${num(line.baseline)} cm`, rgbOps(col, "rg"));
      const shear = f.italic ? Math.tan((12 * Math.PI) / 180) : 0;
      // Whitespace stays as positioning: complete CJK faces can alias blanks.
      let runX = 0;
      for (const run of f.text.split(/(\s+)/u)) {
        if (run && !/^\s+$/u.test(run))
          out.push("BT", `/${key} ${num(f.fontSize)} Tf`, `1 0 ${num(shear)} 1 ${num(runX)} 0 Tm`,
            `${font.encodeText(run).toString()} Tj`, "ET");
        runX += font.widthOfTextAtSize(run, f.fontSize);
      }
      if (f.underline) {
        out.push(rgbOps(col, "RG"), `${num(Math.max(0.5, f.fontSize / 18))} w`,
          `0 ${num(-f.fontSize * 0.1)} m ${num(font.widthOfTextAtSize(f.text, f.fontSize))} ${num(-f.fontSize * 0.1)} l S`);
      }
      out.push("Q");
    }
  }
  out.push("Q");
  return out;
}

function shapeOps(a: Annotation): string[] {
  const style = a.style ?? { color: "#000000", width: 1 };
  const width = Math.max(0, style.width ?? 1);
  const out: string[] = [];
  const rect = a.rect;
  const paint = (filled: boolean) => (filled && width > 0 ? "B" : filled ? "f" : width > 0 ? "S" : "n");
  const strokeSetup = () => out.push(rgbOps(style.color, "RG"), `${num(width)} w`);
  if (a.type === "rect" && rect) {
    const filled = hasFill(style.fill);
    strokeSetup();
    if (filled) out.push(rgbOps(style.fill, "rg"));
    out.push(`${num(rect.x)} ${num(rect.y)} ${num(rect.w)} ${num(rect.h)} re ${paint(filled)}`);
  } else if (a.type === "ellipse" && rect) {
    const filled = hasFill(style.fill);
    strokeSetup();
    if (filled) out.push(rgbOps(style.fill, "rg"));
    const k = 0.5522847498, rx = rect.w / 2, ry = rect.h / 2, cx = rect.x + rx, cy = rect.y + ry;
    out.push(
      `${num(cx + rx)} ${num(cy)} m`,
      `${num(cx + rx)} ${num(cy + k * ry)} ${num(cx + k * rx)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
      `${num(cx - k * rx)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + k * ry)} ${num(cx - rx)} ${num(cy)} c`,
      `${num(cx - rx)} ${num(cy - k * ry)} ${num(cx - k * rx)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
      `${num(cx + k * rx)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - k * ry)} ${num(cx + rx)} ${num(cy)} c h ${paint(filled)}`,
    );
  } else if (a.points?.length && (a.type === "line" || a.type === "arrow" || a.type === "pen")) {
    const pts: Point[] = a.points.map((p) => ({ ...p }));
    strokeSetup();
    out.push("1 J 1 j");
    let head: string | undefined;
    if (a.type === "arrow" && pts.length > 1) {
      const tip = pts[pts.length - 1], prev = pts[pts.length - 2];
      const len = 9 * width, half = 3 * width;
      const dx = tip.x - prev.x, dy = tip.y - prev.y, dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      const bx = tip.x - ux * len, by = tip.y - uy * len;
      head = `${rgbOps(style.color, "rg")} ${num(tip.x)} ${num(tip.y)} m ${num(bx - uy * half)} ${num(by + ux * half)} l ${num(bx + uy * half)} ${num(by - ux * half)} l h f`;
      // Shorten the shaft to the head base so the round cap cannot poke past the tip.
      if (dist > len) pts[pts.length - 1] = { x: bx, y: by };
      else pts.pop();
    }
    if (pts.length) {
      const first = pts[0];
      out.push(`${num(first.x)} ${num(first.y)} m`);
      if (pts.length === 1) out.push(`${num(first.x)} ${num(first.y)} l`);
      for (const p of pts.slice(1)) out.push(`${num(p.x)} ${num(p.y)} l`);
      out.push("S");
    }
    if (head) out.push(head);
  } else if (isMarkup(a.type)) {
    for (const q of markupQuads(a)) {
      if (a.type === "highlight") {
        out.push(rgbOps(style.color, "rg"), `${num(q.x)} ${num(q.y)} ${num(q.w)} ${num(q.h)} re f`);
      } else {
        const t = Math.max(0.5, 0.07 * q.h);
        const y = a.type === "underline" ? q.y + q.h - t / 2 : q.y + q.h / 2;
        out.push(rgbOps(style.color, "RG"), `${num(t)} w`, `${num(q.x)} ${num(y)} m ${num(q.x + q.w)} ${num(y)} l S`);
      }
    }
  }
  return out;
}

/**
 * Builds a form XObject in page user space: BBox = annotation bounds (with
 * stroke padding) and content already carries the rotation/crop matrix.
 */
export async function buildAppearance(
  pdf: PDFDocument,
  page: PDFPage,
  a: Annotation,
  fonts: FontProvider,
): Promise<Appearance> {
  checkGeometry(a);
  const m = pageMatrix(page);
  const bounds = displayBounds(a);
  if (!bounds) return { bbox: [0, 0, 0, 0] };
  const bbox = userBounds(m, bounds);
  const style = a.style ?? { color: "#000000", width: 1 };
  const res = withResources();
  const ops: string[] = [`${m.map(num).join(" ")} cm`];
  let body: string[] = [];
  const rect = a.rect;
  if (a.type === "text" && rect) body = await textOps(a, rect, fonts, res);
  else if (a.type === "image" && rect) {
    const source = a.payload?.imageSrc;
    if (!source) throw new Error("Export image must be normalized PNG or JPEG data URL");
    const image = await embedImage(pdf, source);
    const key = res.xobject(image.ref);
    const angle = ((a.rotation ?? 0) * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
    const swap = a.rotation === 90 || a.rotation === 270;
    const w = swap ? rect.h : rect.w, h = swap ? rect.w : rect.h;
    body = ["q", `${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(rect.x + rect.w / 2)} ${num(rect.y + rect.h / 2)} cm`,
      `1 0 0 -1 ${num(-w / 2)} ${num(h / 2)} cm`, `${num(w)} 0 0 ${num(h)} 0 0 cm`, `/${key} Do`, "Q"];
  } else body = shapeOps(a);
  if (!body.length) return { bbox };
  ops.push(...body);

  const defaultOpacity = a.type === "highlight" ? 0.32 : 1;
  const opacity = Math.max(0, Math.min(1, style.opacity ?? defaultOpacity));
  const gs: Record<string, unknown> = { Type: "ExtGState", CA: opacity, ca: opacity };
  if (a.type === "highlight") gs.BM = PDFName.of("Multiply");
  ops.unshift("/GS0 gs");

  const ctx = pdf.context;
  const fontDict = ctx.obj(Object.fromEntries([...res.fonts].map(([k, v]) => [k, v])));
  const xDict = ctx.obj(Object.fromEntries([...res.xobjects].map(([k, v]) => [k, v])));
  const resources = ctx.obj({
    ExtGState: { GS0: { ...gs, Type: PDFName.of("ExtGState") } },
    ...(res.fonts.size ? { Font: fontDict } : {}),
    ...(res.xobjects.size ? { XObject: xDict } : {}),
  });
  const stream = ctx.flateStream(ops.join("\n"), {
    Type: PDFName.of("XObject"),
    Subtype: PDFName.of("Form"),
    FormType: 1,
    BBox: ctx.obj(bbox),
    Resources: resources,
  });
  return { ref: ctx.register(stream), bbox };
}

// ------------------------------------------------------------- annotations

const SUBTYPE: Record<string, string> = {
  text: "FreeText", rect: "Square", ellipse: "Circle", line: "Line", arrow: "Line", pen: "Ink",
  highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", image: "Stamp",
};

function annotationJson(a: Annotation): string {
  const copy: Annotation = JSON.parse(JSON.stringify(a));
  if (copy.payload) {
    delete copy.payload.layout;
    // The Stamp appearance already carries the pixels; readAnnotations rebuilds the data URL from it.
    if (a.type === "image" && copy.payload.imageSrc) {
      delete copy.payload.imageSrc;
      (copy.payload as Record<string, unknown>).imageFromAppearance = true;
    }
    if (!Object.keys(copy.payload).length) delete copy.payload;
  }
  return JSON.stringify(copy);
}

const hexOfUtf8 = (s: string) => Buffer.from(s, "utf8").toString("hex");

function isRusty(dict: PDFDict): boolean {
  return dict.has(RUSTY_KEY);
}

export async function writeAnnotations(
  pdf: PDFDocument,
  data: AnnotationSidecar,
  fontsDir?: string,
): Promise<void> {
  if (!data || !Array.isArray(data.annotations)) throw new Error("Invalid annotations");
  for (const a of data.annotations)
    if (!Number.isInteger(a.page) || a.page < 0 || a.page >= pdf.getPageCount())
      throw new Error("Invalid annotation page");
  stripAnnotations(pdf);
  const fonts = createFontProvider(pdf, data.annotations.map(annotationText).join(""), fontsDir);
  const ctx = pdf.context;
  for (const a of data.annotations) {
    const page = pdf.getPage(a.page);
    const style = a.style ?? { color: "#000000", width: 1 };
    const subtype = SUBTYPE[a.type];
    if (!subtype) continue;
    const ap = await buildAppearance(pdf, page, a, fonts);
    const m = pageMatrix(page);
    const opacity = Math.max(0, Math.min(1, style.opacity ?? (a.type === "highlight" ? 0.32 : 1)));
    const dict: Record<string, unknown> = {
      Type: "Annot",
      Subtype: PDFName.of(subtype),
      Rect: ap.bbox,
      F: 4,
      C: rgbOf(style.color),
      CA: opacity,
      NM: PDFHexString.of(hexOfUtf8(NAME_PREFIX + a.id)),
      RustyPDF: PDFHexString.of(hexOfUtf8(annotationJson(a))),
    };
    const text = a.type === "text" ? fallbackText(a) || annotationText(a) : undefined;
    if (text) dict.Contents = PDFHexString.fromText(text);
    if (ap.ref) dict.AP = { N: ap.ref };
    if (subtype === "FreeText") dict.DA = PDFString.of("0 g /Helv 12 Tf");
    if (hasFill(style.fill) && (a.type === "rect" || a.type === "ellipse")) dict.IC = rgbOf(style.fill);
    if (a.type === "rect" || a.type === "ellipse") dict.BS = { W: Math.max(0, style.width ?? 1) };
    if ((a.type === "line" || a.type === "arrow") && a.points && a.points.length >= 2) {
      const p0 = a.points[0], p1 = a.points[a.points.length - 1];
      dict.L = [...apply(m, p0.x, p0.y), ...apply(m, p1.x, p1.y)];
      dict.BS = { W: Math.max(0, style.width ?? 1) };
      if (a.type === "arrow") dict.LE = [PDFName.of("None"), PDFName.of("ClosedArrow")];
    }
    if (a.type === "pen" && a.points?.length)
      dict.InkList = [a.points.flatMap((p) => apply(m, p.x, p.y))];
    if (isMarkup(a.type)) {
      const quads = markupQuads(a);
      dict.QuadPoints = quads.flatMap((q) => [
        ...apply(m, q.x, q.y), ...apply(m, q.x + q.w, q.y),
        ...apply(m, q.x, q.y + q.h), ...apply(m, q.x + q.w, q.y + q.h),
      ]);
    }
    const ref = ctx.register(ctx.obj(dict as any) as unknown as PDFDict);
    let annots = page.node.Annots();
    if (!annots) {
      annots = ctx.obj([]);
      page.node.set(PDFName.of("Annots"), annots);
    }
    annots.push(ref);
  }
}

// ----------------------------------------------- image rebuilt from the appearance

let crcTable: Uint32Array | undefined;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width: number, height: number, channels: number, pixels: Uint8Array, alpha?: Uint8Array): Buffer {
  const color = channels === 3 ? (alpha ? 6 : 2) : alpha ? 4 : 0;
  const outCh = channels + (alpha ? 1 : 0);
  const raw = Buffer.alloc(height * (1 + width * outCh));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      for (let c = 0; c < channels; c++) raw[o++] = pixels[i * channels + c];
      if (alpha) raw[o++] = alpha[i];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = color;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function singleFilter(dict: PDFDict): string | undefined {
  let f = dict.lookup(PDFName.of("Filter"));
  if (f instanceof PDFArray && f.size() === 1) f = f.lookup(0);
  return f instanceof PDFName ? f.decodeText() : undefined;
}

const intOf = (dict: PDFDict, key: string) => {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : 0;
};

/** Reads the image XObject an image Stamp's appearance draws back into a data URL (undefined when unsupported). */
function imageFromAppearance(dict: PDFDict): string | undefined {
  try {
    const ap = dict.lookupMaybe(PDFName.of("AP"), PDFDict)?.lookup(PDFName.of("N"));
    if (!(ap instanceof PDFStream)) return undefined;
    const xobjects = ap.dict.lookupMaybe(PDFName.of("Resources"), PDFDict)?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xobjects) return undefined;
    for (const [key] of xobjects.entries()) {
      const image = xobjects.lookup(key);
      if (!(image instanceof PDFStream)) continue;
      if ((image.dict.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.toString() !== "/Image") continue;
      const filter = singleFilter(image.dict);
      if (filter === "DCTDecode")
        return `data:image/jpeg;base64,${Buffer.from(image.getContents()).toString("base64")}`;
      if (filter !== "FlateDecode" || intOf(image.dict, "BitsPerComponent") !== 8) return undefined;
      const space = (image.dict.lookup(PDFName.of("ColorSpace")) as PDFName | undefined)?.toString();
      const channels = space === "/DeviceRGB" ? 3 : space === "/DeviceGray" ? 1 : 0;
      const width = intOf(image.dict, "Width"), height = intOf(image.dict, "Height");
      if (!channels || width < 1 || height < 1) return undefined;
      const pixels = inflateSync(image.getContents());
      if (pixels.length !== width * height * channels) return undefined;
      let alpha: Uint8Array | undefined;
      const mask = image.dict.lookup(PDFName.of("SMask"));
      if (mask instanceof PDFStream) {
        if (singleFilter(mask.dict) !== "FlateDecode") return undefined;
        alpha = inflateSync(mask.getContents());
        if (alpha.length !== width * height) return undefined;
      }
      return `data:image/png;base64,${encodePng(width, height, channels, pixels, alpha).toString("base64")}`;
    }
  } catch {
    // Damaged image: leave the annotation without pixels rather than failing the load.
  }
  return undefined;
}

export function readAnnotations(pdf: PDFDocument): Annotation[] {
  const out: Annotation[] = [];
  pdf.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const raw = dict?.lookup(RUSTY_KEY);
      if (!dict || !(raw instanceof PDFHexString)) continue;
      try {
        const parsed = JSON.parse(Buffer.from(raw.asBytes()).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string" || typeof parsed.type !== "string") continue;
        if (parsed.payload?.imageFromAppearance) {
          const { imageFromAppearance: _marker, ...payload } = parsed.payload;
          parsed.payload = payload;
          const src = !payload.imageSrc ? imageFromAppearance(dict) : undefined;
          if (src) parsed.payload.imageSrc = src;
        }
        out.push({ ...parsed, page: index } as Annotation);
      } catch {
        // Malformed RustyPDF entry: ignore it, keep the document usable.
      }
    }
  });
  return out;
}

/** Removes every RustyPDF annotation (and its appearance); returns how many. */
export function stripAnnotations(pdf: PDFDocument): number {
  let count = 0;
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep: unknown[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const dict = annots.lookupMaybe(i, PDFDict);
      if (dict && isRusty(dict)) {
        count++;
        const ap = dict.lookupMaybe(PDFName.of("AP"), PDFDict)?.get(PDFName.of("N"));
        if (ap instanceof PDFRef) pdf.context.delete(ap);
        if (entry instanceof PDFRef) pdf.context.delete(entry);
      } else keep.push(entry);
    }
    if (keep.length === annots.size()) continue;
    if (keep.length) page.node.set(PDFName.of("Annots"), pdf.context.obj(keep as any));
    else page.node.delete(PDFName.of("Annots"));
  }
  if (count) dropUnreachable(pdf);
  return count;
}

/** Deletes objects nothing references any more (stripped appearances leave fonts and images behind). */
function dropUnreachable(pdf: PDFDocument) {
  const ctx = pdf.context;
  const seen = new Set<string>();
  const stack: unknown[] = [];
  const info = ctx.trailerInfo as Record<string, unknown>;
  for (const key of ["Root", "Info", "Encrypt"]) if (info[key]) stack.push(info[key]);
  while (stack.length) {
    const node = stack.pop();
    if (node instanceof PDFRef) {
      if (seen.has(node.tag)) continue;
      seen.add(node.tag);
      stack.push(ctx.lookup(node));
    } else if (node instanceof PDFStream) stack.push(node.dict);
    else if (node instanceof PDFDict) for (const [, v] of node.entries()) stack.push(v);
    else if (node instanceof PDFArray) for (let i = 0; i < node.size(); i++) stack.push(node.get(i));
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}
