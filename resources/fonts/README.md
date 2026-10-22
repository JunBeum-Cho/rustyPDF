# Bundled Korean export fonts

NotoSansKR-Regular.ttf and NotoSansKR-Bold.ttf are static weight instances
(400 and 700) of the official Noto Sans KR variable TrueType font:
https://github.com/google/fonts/blob/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf

Licensed under the SIL Open Font License 1.1; see OFL.txt. Generated with
FontTools `instantiateVariableFont(font, {"wght": weight}, inplace=True)`.
These complete TrueType faces are embedded without fontkit subsetting because
fontkit subsets of the original CJK CFF font produced malformed glyph outlines.
Complete faces preserve Korean glyphs in PDF.js; italic is a horizontal shear.

NotoSerifKR-Regular.ttf and NotoSerifKR-Bold.ttf are static 400/700 instances
of the official Noto Serif KR variable TrueType source:
https://github.com/google/fonts/blob/main/ofl/notoserifkr/NotoSerifKR%5Bwght%5D.ttf
Downloaded 2026-10-22; see NotoSerifKR-OFL.txt for its original license.
Generated with the same FontTools instancing command described above.

Both families are served to Chromium from public/fonts by prepare-assets.mjs,
and embedded from resources/assets/fonts in packaged exports. Only upright
faces are bundled; CSS oblique 12deg and PDF text matrix horizontal shear
tan(12deg) supply the same synthetic italic. Kerning, ligatures, and contextual alternates/localized forms (`calt`, `locl`) are disabled
in annotation DOM to match pdf-lib widthOfTextAtSize advance metrics. Noto calt/locl
widen Korean-adjacent spaces differently in Chromium and fontkit or under
Korean document language; disabling them preserves predictable spacing.
