import { ANNOTATION_FONT_FEATURES, fontFileName, normalizeFontFamily } from "../src/annotations/fonts.js";
import { addOcrTextLayer } from "./ocr-export.js";
import type { OcrPage } from "./pdf-types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  LineCapStyle,
  degrees,
  type PDFFont,
} from "pdf-lib";
import type { AnnotationSidecar } from "../src/annotations/types.js";
function color(hex: string | undefined) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  const n = parseInt(m?.[1] ?? "000000", 16);
  return rgb((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function finite(...values: number[]) {
  if (!values.every(Number.isFinite))
    throw new Error("Invalid annotation geometry");
}
export async function flattenPdf(
  bytes: Uint8Array,
  input: unknown,
  assetsDir?: string,
  ocrPages?: ReadonlyMap<number, OcrPage>,
) {
  const data = input as AnnotationSidecar;
  if (!data || !Array.isArray(data.annotations))
    throw new Error("Invalid export annotations");
  const pdf = await PDFDocument.load(bytes);
  pdf.registerFontkit(fontkit);
  const fonts = new Map<string, PDFFont>();
  const getFont = async (family?: string, bold = false): Promise<PDFFont> => {
    const name = fontFileName(family, bold);
    if (!fonts.has(name)) {
      const path = assetsDir
        ? join(assetsDir, "fonts", name)
        : fileURLToPath(new URL(`../resources/fonts/${name}`, import.meta.url));
      fonts.set(
        name,
        // fontkit subsets corrupt CJK outlines; complete TrueType faces render
        // reliably in PDF.js and preserve every Korean glyph.
        await pdf.embedFont(await readFile(path), { subset: false, features: ANNOTATION_FONT_FEATURES }),
      );
    }
    return fonts.get(name)!;
  };
  const imageCache = new Map<string, any>();
  for (const a of data.annotations) {
    if (!Number.isInteger(a.page) || a.page < 0 || a.page >= pdf.getPageCount())
      throw new Error("Invalid annotation page");
    const page = pdf.getPage(a.page),
      box = page.getCropBox(),
      r = ((page.getRotation().angle % 360) + 360) % 360;
    const matrices: Record<
      number,
      [number, number, number, number, number, number]
    > = {
      0: [1, 0, 0, -1, box.x, box.y + box.height],
      90: [0, 1, 1, 0, box.x, box.y],
      180: [-1, 0, 0, 1, box.x + box.width, box.y],
      270: [0, -1, -1, 0, box.x + box.width, box.y + box.height],
    };
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(...matrices[r]),
    );
    const style = a.style ?? { color: "#000000", width: 1 };
    const opacity = Math.max(0, Math.min(1, style.opacity ?? 1));
    const width = Math.max(0, style.width ?? 1);
    const stroke = color(style.color),
      fill =
        style.fill && style.fill !== "transparent"
          ? color(style.fill)
          : undefined;
    const rect = a.rect;
    if (rect) finite(rect.x, rect.y, rect.w, rect.h);
    if (a.type === "text" && rect) {
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(
          1,
          0,
          0,
          1,
          rect.x + rect.w / 2,
          rect.y + rect.h / 2,
        ),
      );
      const angle = ((a.rotation ?? 0) * Math.PI) / 180,
        c = Math.cos(angle),
        s = Math.sin(angle);
      page.pushOperators(
        concatTransformationMatrix(
          c,
          s,
          -s,
          c,
          -(a.rotation === 90 || a.rotation === 270 ? rect.h : rect.w) / 2,
          -(a.rotation === 90 || a.rotation === 270 ? rect.w : rect.h) / 2,
        ),
      );

      const layout = a.payload?.layout;
      const lines =
        Array.isArray(layout) && layout.length
          ? layout
          : [
              {
                baseline: style.fontSize ?? 16,
                fragments: [
                  {
                    text: a.payload?.text ?? "",
                    x: 0,
                    fontSize: style.fontSize ?? 16,
                    color: style.color,
                    fontFamily: normalizeFontFamily(style.fontFamily),
                    bold: style.fontWeight === "bold" || Number(style.fontWeight) >= 600,
                    italic: style.fontStyle === "italic" || style.fontStyle?.startsWith("oblique"),
                    underline: style.textDecoration === "underline",
                  },
                ],
              },
            ];
      for (const line of lines) {
        finite(line.baseline);
        if (!Array.isArray(line.fragments))
          throw new Error("Invalid text layout");
        for (const f of line.fragments) {
          finite(f.x, f.fontSize);
          if (typeof f.text !== "string" || f.fontSize <= 0)
            throw new Error("Invalid text fragment");
          page.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(1, 0, 0, -1, f.x, line.baseline),
          );
          const embedded = await getFont(f.fontFamily ?? style.fontFamily, f.bold);
          // Full embedded CJK fonts can share their space glyph with other Unicode
          // blanks. Keep whitespace as positioning so fontkit cannot alias it to
          // an unrelated code point in the generated text mapping.
          let runX = 0;
          for (const run of f.text.split(/(\s+)/u)) {
            if (run && !/^\s+$/u.test(run))
              page.drawText(run, {
                x: runX,
                y: 0,
                size: f.fontSize,
                font: embedded,
                color: color(f.color ?? style.color),
                opacity,
                ySkew: degrees(f.italic ? 12 : 0),
              });
            runX += embedded.widthOfTextAtSize(run, f.fontSize);
          }
          if (f.underline)
            page.drawLine({
              start: { x: 0, y: -f.fontSize * 0.1 },
              end: {
                x: embedded.widthOfTextAtSize(f.text, f.fontSize),
                y: -f.fontSize * 0.1,
              },
              thickness: Math.max(0.5, f.fontSize / 18),
              color: color(f.color ?? style.color),
              opacity,
            });
          page.pushOperators(popGraphicsState());
        }
      }
      page.pushOperators(popGraphicsState());
    } else if (a.type === "image" && rect) {
      const source = a.payload?.imageSrc;
      if (!source || !/^data:image\/(png|jpe?g);base64,/i.test(source))
        throw new Error("Export image must be normalized PNG or JPEG data URL");
      let image = imageCache.get(source);
      if (!image) {
        const raw = Buffer.from(
          source.slice(source.indexOf(",") + 1),
          "base64",
        );
        image = /^data:image\/png/i.test(source)
          ? await pdf.embedPng(raw)
          : await pdf.embedJpg(raw);
        imageCache.set(source, image);
      }
      const angle = ((a.rotation ?? 0) * Math.PI) / 180,
        c = Math.cos(angle),
        s = Math.sin(angle);
      const w = a.rotation === 90 || a.rotation === 270 ? rect.h : rect.w,
        h = a.rotation === 90 || a.rotation === 270 ? rect.w : rect.h;
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(
          c,
          s,
          -s,
          c,
          rect.x + rect.w / 2,
          rect.y + rect.h / 2,
        ),
        concatTransformationMatrix(1, 0, 0, -1, -w / 2, h / 2),
      );
      page.drawImage(image, { x: 0, y: 0, width: w, height: h, opacity });
      page.pushOperators(popGraphicsState());
    } else if (rect && (a.type === "rect" || a.type === "highlight"))
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        borderColor: a.type === "highlight" ? undefined : stroke,
        borderWidth: a.type === "highlight" ? 0 : width,
        color: a.type === "highlight" ? stroke : fill,
        opacity: a.type === "highlight" ? opacity * 0.3 : opacity,
        borderOpacity: opacity,
      });
    else if (rect && a.type === "ellipse")
      page.drawEllipse({
        x: rect.x + rect.w / 2,
        y: rect.y + rect.h / 2,
        xScale: rect.w / 2,
        yScale: rect.h / 2,
        borderColor: stroke,
        borderWidth: width,
        color: fill,
        opacity,
        borderOpacity: opacity,
      });
    else if (a.points?.length) {
      for (const p of a.points) finite(p.x, p.y);
      for (let i = 1; i < a.points.length; i++)
        page.drawLine({
          start: a.points[i - 1],
          end: a.points[i],
          thickness: width,
          color: stroke,
          opacity,
          lineCap: LineCapStyle.Round,
        });
      if (a.type === "arrow" && a.points.length > 1) {
        const end = a.points[a.points.length - 1],
          start = a.points[a.points.length - 2],
          angle = Math.atan2(end.y - start.y, end.x - start.x),
          size = Math.max(8, width * 4);
        for (const sign of [-1, 1])
          page.drawLine({
            start: end,
            end: {
              x: end.x - size * Math.cos(angle + (sign * Math.PI) / 6),
              y: end.y - size * Math.sin(angle + (sign * Math.PI) / 6),
            },
            thickness: width,
            color: stroke,
            opacity,
          });
      }
    }
    page.pushOperators(popGraphicsState());
  }
  if (ocrPages?.size) await addOcrTextLayer(pdf, ocrPages, () => getFont());
  return pdf.save();
}
