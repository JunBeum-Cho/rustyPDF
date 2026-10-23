import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  PDFDocument,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";

type Matrix = [number, number, number, number, number, number];

// Maps the stored image (w x h, origin bottom-left) to its displayed upright
// orientation for EXIF Orientation 1-8.
export function orientationMatrix(
  orientation: number,
  w: number,
  h: number,
): Matrix {
  const m: Record<number, Matrix> = {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, w, 0],
    3: [-1, 0, 0, -1, w, h],
    4: [1, 0, 0, -1, 0, h],
    5: [0, -1, -1, 0, h, w],
    6: [0, -1, 1, 0, 0, w],
    7: [0, 1, 1, 0, 0, 0],
    8: [0, 1, -1, 0, h, 0],
  };
  return m[orientation] ?? m[1];
}

const LIMIT = 200 * 1024 * 1024;

export async function createPdfFromImages(
  paths: string[],
): Promise<Uint8Array> {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100)
    throw new Error("Select 1–100 images");
  const pdf = await PDFDocument.create();
  let total = 0;
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
      throw new Error("Expected absolute file path");
    if (!/\.(png|jpe?g)$/i.test(path))
      throw new Error("Only PNG and JPEG supported");
    const info = await stat(path);
    if (!info.isFile() || info.size > LIMIT - total)
      throw new Error("Images exceed 200MB");
    const chunks: Buffer[] = [];
    let readBytes = 0;
    for await (const chunk of createReadStream(path)) {
      readBytes += chunk.length;
      if (readBytes > LIMIT - total) throw new Error("Images exceed 200MB");
      chunks.push(chunk as Buffer);
    }
    const bytes = Buffer.concat(chunks);
    total += bytes.length;
    if (total > LIMIT) throw new Error("Images exceed 200MB");
    const png = bytes[0] === 137 && bytes[1] === 80;
    const jpg = bytes[0] === 255 && bytes[1] === 216;
    if (!png && !jpg) throw new Error("Invalid image format");
    let orientation = 1;
    if (jpg) {
      const exifr = await import("exifr");
      orientation = (await exifr.orientation(bytes)) ?? 1;
    }
    if (
      png &&
      (bytes.length < 24 ||
        bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 50_000_000 ||
        bytes.readUInt32BE(16) === 0 ||
        bytes.readUInt32BE(20) === 0)
    )
      throw new Error("Image exceeds 50 million pixels or is invalid");
    // Buffer.concat may return a pooled slice (byteOffset != 0); pdf-lib's JPEG
    // parser then fails with "SOI not found". Hand it a fresh copy.
    const own = new Uint8Array(bytes);
    const image = png ? await pdf.embedPng(own) : await pdf.embedJpg(own);
    if (image.width * image.height > 50_000_000)
      throw new Error("Image exceeds 50 million pixels");
    const sideways = orientation >= 5;
    const w = sideways ? image.height : image.width,
      h = sideways ? image.width : image.height;
    const [pw, ph] = w > h ? [841.8898, 595.2756] : [595.2756, 841.8898];
    const page = pdf.addPage([pw, ph]);
    const scale = Math.min((pw - 56.6929) / w, (ph - 56.6929) / h);
    const x = (pw - w * scale) / 2,
      y = (ph - h * scale) / 2;
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(scale, 0, 0, scale, x, y),
      concatTransformationMatrix(
        ...orientationMatrix(orientation, image.width, image.height),
      ),
    );
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
    page.pushOperators(popGraphicsState());
  }
  return pdf.save();
}
