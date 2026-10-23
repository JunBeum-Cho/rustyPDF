import { PDFDocument, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";
import type { AnnotationSidecar } from "../src/annotations/types.js";
import { addOcrTextLayer, ocrText } from "./ocr-export.js";
import { annotationText, buildAppearance, createFontProvider, stripAnnotations } from "./pdf-annotations.js";
import type { OcrPage } from "./pdf-types.js";

/** Draw every annotation's appearance into page content and add OCR text. */
export async function flattenPdf(
  bytes: Uint8Array,
  input: unknown,
  fontsDir?: string,
  ocrPages?: ReadonlyMap<number, OcrPage>,
): Promise<Uint8Array> {
  const data = input as AnnotationSidecar;
  if (!data || !Array.isArray(data.annotations)) throw new Error("Invalid export annotations");
  const pdf = await PDFDocument.load(bytes);
  for (const a of data.annotations)
    if (!Number.isInteger(a.page) || a.page < 0 || a.page >= pdf.getPageCount())
      throw new Error("Invalid annotation page");
  // Embedded RustyPDF annotations would otherwise be drawn twice.
  stripAnnotations(pdf);
  const text = data.annotations.map(annotationText).join("") + (ocrPages ? ocrText(ocrPages) : "");
  const fonts = createFontProvider(pdf, text, fontsDir);
  let counter = 0;
  for (const a of data.annotations) {
    const page = pdf.getPage(a.page);
    const ap = await buildAppearance(pdf, page, a, fonts);
    if (!ap.ref) continue;
    const name = page.node.newXObject(`RustyAnn${counter++}`, ap.ref);
    page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
  }
  if (ocrPages?.size) await addOcrTextLayer(pdf, ocrPages, fontsDir, fonts);
  return pdf.save();
}
