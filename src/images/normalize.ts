/** JPEG sources are re-encoded so EXIF orientation is baked in (§2.5). */
export const needsOrientationBake = (source: string): boolean =>
  /^data:image\/jpe?g;base64,/i.test(source);

const dataUrlToBlob = (source: string): Blob => {
  const comma = source.indexOf(",");
  const mime = /^data:([^;,]+)/i.exec(source)?.[1] ?? "image/jpeg";
  const bin = atob(source.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

const bakeJpegOrientation = async (source: string): Promise<string> => {
  const bitmap = await createImageBitmap(dataUrlToBlob(source), {
    imageOrientation: "from-image",
  });
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 32_000_000)
      throw new Error("이미지가 너무 큽니다.");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("이미지 변환에 실패했습니다.");
    context.drawImage(bitmap, 0, 0);
    try {
      return canvas.toDataURL("image/jpeg", 0.92);
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    bitmap.close();
  }
};

/** Rasterize browser-supported image formats once for the PDF exporter. */
export async function normalizeImageSource(source: string): Promise<string> {
  if (/^data:image\/png;base64,/i.test(source)) return source;
  if (needsOrientationBake(source)) return bakeJpegOrientation(source);
  if (!/^data:image\//i.test(source))
    throw new Error("이미지 데이터가 올바르지 않습니다.");
  if (/^data:image\/svg\+xml/i.test(source)) {
    const comma = source.indexOf(",");
    const xml = /;base64/i.test(source.slice(0, comma))
      ? new TextDecoder().decode(
          Uint8Array.from(atob(source.slice(comma + 1)), (c) =>
            c.charCodeAt(0),
          ),
        )
      : decodeURIComponent(source.slice(comma + 1));
    const doc = new DOMParser().parseFromString(xml, "image/svg+xml");
    doc
      .querySelectorAll("script,foreignObject,style,iframe")
      .forEach((el) => el.remove());
    for (const el of doc.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        if (
          /^on/i.test(attr.name) ||
          (/href$/i.test(attr.name) && !attr.value.startsWith("#")) ||
          /url\s*\(/i.test(attr.value)
        )
          el.removeAttribute(attr.name);
      }
    }
    source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(doc))}`;
  }
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 읽을 수 없습니다."));
    image.src = source;
  });
  if (
    !image.naturalWidth ||
    !image.naturalHeight ||
    image.naturalWidth * image.naturalHeight > 32_000_000
  )
    throw new Error("이미지가 너무 큽니다.");
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이미지 변환에 실패했습니다.");
  context.drawImage(image, 0, 0);
  try {
    return canvas.toDataURL("image/png");
  } finally {
    canvas.width = canvas.height = 0;
  }
}
