/** Shared offline typography for annotation DOM, measurement and PDF embedding. */
export const COMMON_FONTS = ["Noto Sans KR", "Noto Serif KR"] as const;
export type AnnotationFontFamily = typeof COMMON_FONTS[number];
export const normalizeFontFamily = (family?: string | null): AnnotationFontFamily => {
  const first = (family ?? "").split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return ["noto serif kr", "times new roman", "times", "georgia", "serif", "noto serif", "batang", "바탕"].includes(first)
    ? "Noto Serif KR" : "Noto Sans KR";
};
export const fontFileName = (family?: string | null, bold = false): string =>
  `${normalizeFontFamily(family) === "Noto Serif KR" ? "NotoSerifKR" : "NotoSansKR"}-${bold ? "Bold" : "Regular"}.ttf`;

/** Explicit loads include unused inline families/weights before offscreen layout. */
export const ensureAnnotationFonts = async (doc: Document = document): Promise<void> => {
  if (!doc.fonts) return;
  await Promise.all(COMMON_FONTS.flatMap((family) => [400, 700].map(async (weight) => {
    const faces = await doc.fonts.load(`${weight} 16px "${family}"`, "한글 RustyPDF");
    if (faces.length === 0) throw new Error(`Bundled annotation font unavailable: ${family} ${weight}`);
  })));
};

// Noto calt/locl widen Korean spaces differently across shaping engines/locales.
export const ANNOTATION_FONT_FEATURES = { kern: false, liga: false, clig: false, calt: false, locl: false };
