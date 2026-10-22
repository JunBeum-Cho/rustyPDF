import {
  PDFDocument, PDFFont, pushGraphicsState, popGraphicsState,
  concatTransformationMatrix, beginText, endText, setFontAndSize,
  setTextRenderingMode, TextRenderingMode, setTextMatrix, showText,
} from "pdf-lib";
import type { OcrPage } from "./pdf-types.js";

/** Add completed OCR in intrinsic-rotation display coordinates, without ink. */
export async function addOcrTextLayer(
  pdf: PDFDocument,
  pages: ReadonlyMap<number, OcrPage>,
  getFont: () => Promise<PDFFont>,
): Promise<void> {
  let font: PDFFont | undefined;
  for (const [index, result] of pages) {
    if (!Number.isInteger(index) || index < 0 || index >= pdf.getPageCount())
      throw new Error("Invalid OCR page");
    const page = pdf.getPage(index), box = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const matrices: Record<number, [number, number, number, number, number, number]> = {
      0: [1, 0, 0, -1, box.x, box.y + box.height],
      90: [0, 1, 1, 0, box.x, box.y],
      180: [-1, 0, 0, 1, box.x + box.width, box.y],
      270: [0, -1, -1, 0, box.x + box.width, box.y + box.height],
    };
    if (!matrices[rotation]) throw new Error("Invalid OCR page rotation");
    const width = rotation % 180 ? box.height : box.width;
    const height = rotation % 180 ? box.width : box.height;
    for (const line of result.lines) {
      if (![line.x, line.y, line.w, line.h].every(Number.isFinite) ||
        line.x < 0 || line.y < 0 || line.w < 0 || line.h < 0 ||
        line.x + line.w > 1 + 1e-9 || line.y + line.h > 1 + 1e-9)
        throw new Error("Invalid OCR geometry");
      // Recognition can yield blank/degenerate boxes. Never ask for a font for them.
      if (!line.text.trim() || !line.w || !line.h) continue;
      font ??= await getFont();
      // A line is one OCR bounding box. Normalize internal whitespace, then let
      // PDF.js infer spaces from positioned runs, avoiding CJK blank glyph aliases.
      const text = line.text.trim().replace(/\s+/gu, " ");
      const size = line.h * height / font.heightAtSize(1);
      const naturalWidth = font.widthOfTextAtSize(text, size);
      if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(naturalWidth) || naturalWidth <= 0)
        throw new Error("Invalid OCR geometry");
      const scale = line.w * width / naturalWidth;
      const baseline = line.y * height + font.heightAtSize(size, { descender: false });
      const key = page.node.newFontDictionary(font.name, font.ref);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrices[rotation]),
        beginText(), setFontAndSize(key, size), setTextRenderingMode(TextRenderingMode.Invisible));
      let x = line.x * width;
      for (const run of text.split(/( +)/u)) {
        if (run && run.trim())
          page.pushOperators(setTextMatrix(scale, 0, 0, -1, x, baseline), showText(font.encodeText(run)));
        x += font.widthOfTextAtSize(run, size) * scale;
      }
      page.pushOperators(endText(), popGraphicsState());
    }
  }
}
