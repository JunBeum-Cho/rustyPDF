use super::{create_pdfium, PdfError};
use pdfium_render::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::f32::consts::PI;
use std::path::Path;

/// Bundled fonts available for text annotation flattening. The 12 built-in
/// PDF Type-1 fonts are always available; the CJK pair is best-effort —
/// without it, Korean / CJK characters fall back to "."-shaped tofu since
/// Helvetica only ships ASCII glyphs.
struct ExportFonts {
    helvetica: PdfFontToken,
    helvetica_bold: PdfFontToken,
    helvetica_italic: PdfFontToken,
    helvetica_bold_italic: PdfFontToken,
    times: PdfFontToken,
    times_bold: PdfFontToken,
    times_italic: PdfFontToken,
    times_bold_italic: PdfFontToken,
    courier: PdfFontToken,
    courier_bold: PdfFontToken,
    courier_italic: PdfFontToken,
    courier_bold_italic: PdfFontToken,
    /// CID-keyed system font that covers Korean (and most other CJK).
    cjk: Option<PdfFontToken>,
    cjk_bold: Option<PdfFontToken>,
}

#[derive(Clone, Copy, PartialEq)]
enum FontFamilyClass {
    Sans,
    Serif,
    Mono,
}

impl ExportFonts {
    fn load(document: &mut PdfDocument) -> Self {
        let helvetica = document.fonts_mut().helvetica();
        let helvetica_bold = document.fonts_mut().helvetica_bold();
        let helvetica_italic = document.fonts_mut().helvetica_oblique();
        let helvetica_bold_italic = document.fonts_mut().helvetica_bold_oblique();
        let times = document.fonts_mut().times_roman();
        let times_bold = document.fonts_mut().times_bold();
        let times_italic = document.fonts_mut().times_italic();
        let times_bold_italic = document.fonts_mut().times_bold_italic();
        let courier = document.fonts_mut().courier();
        let courier_bold = document.fonts_mut().courier_bold();
        let courier_italic = document.fonts_mut().courier_oblique();
        let courier_bold_italic = document.fonts_mut().courier_bold_oblique();

        // System CJK fonts: probe a short list of canonical install paths.
        // We only need ONE that loads — malgun.ttf on Windows, AppleSDGothicNeo
        // on macOS, Noto CJK on common Linux distros. Anything else falls
        // through to built-in Helvetica (which then mangles Korean).
        const CJK_REGULAR_CANDIDATES: &[&str] = &[
            r"C:\Windows\Fonts\malgun.ttf",
            r"C:\Windows\Fonts\NanumGothic.ttf",
            "/System/Library/Fonts/AppleSDGothicNeo.ttc",
            "/Library/Fonts/AppleSDGothicNeo.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        ];
        const CJK_BOLD_CANDIDATES: &[&str] = &[
            r"C:\Windows\Fonts\malgunbd.ttf",
            r"C:\Windows\Fonts\NanumGothicBold.ttf",
            "/System/Library/Fonts/AppleSDGothicNeo.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
        ];
        let cjk = load_first_existing_ttf(document, CJK_REGULAR_CANDIDATES);
        let cjk_bold = load_first_existing_ttf(document, CJK_BOLD_CANDIDATES).or(cjk);

        Self {
            helvetica,
            helvetica_bold,
            helvetica_italic,
            helvetica_bold_italic,
            times,
            times_bold,
            times_italic,
            times_bold_italic,
            courier,
            courier_bold,
            courier_italic,
            courier_bold_italic,
            cjk,
            cjk_bold,
        }
    }

    /// Pick the closest matching token for the requested style. CJK text
    /// (any non-ASCII codepoint) takes precedence over the family hint —
    /// rendering "안녕" with built-in Helvetica produces empty boxes, so
    /// when CJK is needed and a CJK font is loaded, that wins. Bold maps to
    /// the bold CJK variant if loaded; italic falls through to regular
    /// because Korean fonts don't ship a meaningful italic style.
    fn pick(&self, family: Option<&str>, bold: bool, italic: bool, has_cjk: bool) -> PdfFontToken {
        if has_cjk {
            if bold {
                if let Some(t) = self.cjk_bold {
                    return t;
                }
            }
            if let Some(t) = self.cjk {
                return t;
            }
        }
        match classify_font_family(family) {
            FontFamilyClass::Serif => match (bold, italic) {
                (false, false) => self.times,
                (true, false) => self.times_bold,
                (false, true) => self.times_italic,
                (true, true) => self.times_bold_italic,
            },
            FontFamilyClass::Mono => match (bold, italic) {
                (false, false) => self.courier,
                (true, false) => self.courier_bold,
                (false, true) => self.courier_italic,
                (true, true) => self.courier_bold_italic,
            },
            FontFamilyClass::Sans => match (bold, italic) {
                (false, false) => self.helvetica,
                (true, false) => self.helvetica_bold,
                (false, true) => self.helvetica_italic,
                (true, true) => self.helvetica_bold_italic,
            },
        }
    }
}

fn load_first_existing_ttf(
    document: &mut PdfDocument,
    candidates: &[&str],
) -> Option<PdfFontToken> {
    for path in candidates {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        if let Ok(token) = document.fonts_mut().load_true_type_from_bytes(&bytes, true) {
            return Some(token);
        }
    }
    None
}

fn classify_font_family(family: Option<&str>) -> FontFamilyClass {
    let Some(value) = family else {
        return FontFamilyClass::Sans;
    };
    // The CSS font-family list comes through verbatim; pick the first token.
    let first = value
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase();
    if first.contains("serif") && !first.contains("sans") {
        return FontFamilyClass::Serif;
    }
    if first.contains("times") || first.contains("georgia") || first.contains("garamond") {
        return FontFamilyClass::Serif;
    }
    if first.contains("mono")
        || first.contains("courier")
        || first.contains("consolas")
        || first.contains("menlo")
    {
        return FontFamilyClass::Mono;
    }
    FontFamilyClass::Sans
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationSidecar {
    #[serde(default)]
    annotations: Vec<AnnotationData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationData {
    page: usize,
    #[serde(rename = "type")]
    kind: AnnotationKind,
    #[serde(default)]
    rect: Option<AnnotationRect>,
    #[serde(default)]
    points: Vec<AnnotationPoint>,
    #[serde(default)]
    style: AnnotationStyle,
    #[serde(default)]
    payload: AnnotationPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AnnotationKind {
    Text,
    Rect,
    Ellipse,
    Line,
    Arrow,
    Pen,
    Highlight,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct AnnotationRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct AnnotationPoint {
    x: f32,
    y: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationStyle {
    #[serde(default = "default_color")]
    color: String,
    #[serde(default = "default_width")]
    width: f32,
    #[serde(default)]
    fill: Option<String>,
    #[serde(default = "default_opacity")]
    opacity: f32,
    #[serde(default = "default_font_size")]
    font_size: f32,
    #[serde(default)]
    font_family: Option<String>,
    #[serde(default)]
    font_weight: Option<String>,
    #[serde(default)]
    font_style: Option<String>,
    #[serde(default)]
    text_decoration: Option<String>,
    #[serde(default)]
    text_align: Option<String>,
}

impl Default for AnnotationStyle {
    fn default() -> Self {
        Self {
            color: default_color(),
            width: default_width(),
            fill: None,
            opacity: default_opacity(),
            font_size: default_font_size(),
            font_family: None,
            font_weight: None,
            font_style: None,
            text_decoration: None,
            text_align: None,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct AnnotationPayload {
    #[serde(default)]
    text: String,
}

fn default_color() -> String {
    "#e11d48".to_string()
}

fn default_width() -> f32 {
    2.0
}

fn default_opacity() -> f32 {
    1.0
}

fn default_font_size() -> f32 {
    16.0
}

pub fn export_flattened_pdf(
    source_path: &str,
    target_path: &str,
    data: Value,
) -> Result<(), PdfError> {
    let sidecar: AnnotationSidecar = serde_json::from_value(data)?;
    let pdfium = create_pdfium()?;
    let mut document = pdfium
        .load_pdf_from_file(Path::new(source_path), None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let fonts = ExportFonts::load(&mut document);
    let page_count = document.pages().len() as usize;
    let mut annotations_by_page: BTreeMap<usize, Vec<AnnotationData>> = BTreeMap::new();

    for annotation in sidecar.annotations {
        if annotation.page < page_count {
            annotations_by_page
                .entry(annotation.page)
                .or_default()
                .push(annotation);
        }
    }

    for (page_index, annotations) in annotations_by_page {
        let mut page = document
            .pages()
            .get(page_index as PdfPageIndex)
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;
        page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
        let page_height = page.height().value;

        for annotation in annotations {
            draw_annotation(&mut page, &annotation, page_height, &fonts)?;
        }

        page.regenerate_content()
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    }

    let bytes = document
        .save_to_bytes()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    std::fs::write(target_path, bytes)?;
    Ok(())
}

fn draw_annotation(
    page: &mut PdfPage<'_>,
    annotation: &AnnotationData,
    page_height: f32,
    fonts: &ExportFonts,
) -> Result<(), PdfError> {
    match annotation.kind {
        AnnotationKind::Text => draw_text(page, annotation, page_height, fonts),
        AnnotationKind::Rect => draw_rect(page, annotation, page_height),
        AnnotationKind::Ellipse => draw_ellipse(page, annotation, page_height),
        AnnotationKind::Line => draw_line_annotation(page, annotation, page_height, false),
        AnnotationKind::Arrow => draw_line_annotation(page, annotation, page_height, true),
        AnnotationKind::Pen => {
            draw_polyline(page, &annotation.points, &annotation.style, page_height)
        }
        AnnotationKind::Highlight => draw_highlight(page, annotation, page_height),
    }
}

fn is_bold_style(style: &AnnotationStyle) -> bool {
    let Some(weight) = style.font_weight.as_deref() else {
        return false;
    };
    let weight = weight.trim().to_ascii_lowercase();
    if matches!(weight.as_str(), "bold" | "bolder") {
        return true;
    }
    weight
        .parse::<u32>()
        .map(|value| value >= 600)
        .unwrap_or(false)
}

fn is_italic_style(style: &AnnotationStyle) -> bool {
    matches!(
        style
            .font_style
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(ref value) if value == "italic" || value == "oblique"
    )
}

fn is_underline_style(style: &AnnotationStyle) -> bool {
    style
        .text_decoration
        .as_deref()
        .map(|value| value.to_ascii_lowercase().contains("underline"))
        .unwrap_or(false)
}

fn align_kind(style: &AnnotationStyle) -> &'static str {
    match style
        .text_align
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("center") => "center",
        Some("right") => "right",
        _ => "left",
    }
}

/// Render a text annotation as flattened page objects. We split on `\n`
/// so the user's visible line breaks survive into the PDF (this is why
/// the frontend now derives `payload.text` with a block-aware walker —
/// `textContent` would have collapsed everything into one line). Each
/// line becomes its own text object so we can place it independently
/// with the requested alignment; underline is a stroked path drawn
/// just below the baseline.
fn draw_text(
    page: &mut PdfPage<'_>,
    annotation: &AnnotationData,
    page_height: f32,
    fonts: &ExportFonts,
) -> Result<(), PdfError> {
    let Some(rect) = annotation.rect else {
        return Ok(());
    };
    let raw = annotation.payload.text.as_str();
    if raw.trim().is_empty() {
        return Ok(());
    }

    let style = &annotation.style;
    let font_size = style.font_size.max(1.0);
    // Match the frontend's CSS line-height: 1.25 so what the user sees in
    // the editor is what they get in the exported PDF.
    let line_height = font_size * 1.25;
    let color = color_from_hex(&style.color, style.opacity);
    let bold = is_bold_style(style);
    let italic = is_italic_style(style);
    let underline = is_underline_style(style);
    let align = align_kind(style);

    let has_cjk = raw.chars().any(|c| (c as u32) > 127);
    let font_token = fonts.pick(style.font_family.as_deref(), bold, italic, has_cjk);

    for (line_index, line) in raw.split('\n').enumerate() {
        if line.is_empty() {
            continue;
        }

        // PDF y-axis is bottom-up. The first line's baseline sits one
        // font-size below the top of the annotation rect; subsequent
        // lines step down by line_height.
        let baseline_y = page_height - rect.y - font_size - (line_index as f32) * line_height;

        let mut object = page
            .objects_mut()
            .create_text_object(
                PdfPoints::ZERO,
                PdfPoints::ZERO,
                line,
                font_token,
                PdfPoints::new(font_size),
            )
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;
        object
            .set_fill_color(color)
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;

        // Measured width in object-local coords. CJK width measurements
        // can be off when the loaded TTF lacks a HMTX entry for a glyph,
        // but the fallback-to-rect-width keeps alignment from blowing up.
        let measured_width = object
            .width()
            .map(|w| w.value)
            .unwrap_or(font_size * 0.55 * line.chars().count() as f32);
        let line_x = match align {
            "center" => rect.x + (rect.w - measured_width) / 2.0,
            "right" => rect.x + rect.w - measured_width,
            _ => rect.x,
        };

        object
            .translate(PdfPoints::new(line_x), PdfPoints::new(baseline_y))
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;

        if underline {
            // Underline: a thin stroked line just below the baseline.
            // 0.08 of font-size is the rough thickness most fonts use.
            let underline_y = baseline_y - font_size * 0.12;
            let underline_thickness = (font_size * 0.06).max(0.5);
            page.objects_mut()
                .create_path_object_line(
                    PdfPoints::new(line_x),
                    PdfPoints::new(underline_y),
                    PdfPoints::new(line_x + measured_width),
                    PdfPoints::new(underline_y),
                    color,
                    PdfPoints::new(underline_thickness),
                )
                .map_err(|e| PdfError::Pdfium(e.to_string()))?;
        }
    }

    Ok(())
}

fn draw_rect(
    page: &mut PdfPage<'_>,
    annotation: &AnnotationData,
    page_height: f32,
) -> Result<(), PdfError> {
    let Some(rect) = annotation.rect else {
        return Ok(());
    };
    let stroke = color_from_hex(&annotation.style.color, annotation.style.opacity);
    let fill = annotation_fill_color(&annotation.style);

    page.objects_mut()
        .create_path_object_rect(
            rect_to_pdf(rect, page_height),
            Some(stroke),
            Some(stroke_width(&annotation.style)),
            fill,
        )
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    Ok(())
}

fn draw_ellipse(
    page: &mut PdfPage<'_>,
    annotation: &AnnotationData,
    page_height: f32,
) -> Result<(), PdfError> {
    let Some(rect) = annotation.rect else {
        return Ok(());
    };
    let stroke = color_from_hex(&annotation.style.color, annotation.style.opacity);
    let fill = annotation_fill_color(&annotation.style);

    page.objects_mut()
        .create_path_object_ellipse(
            rect_to_pdf(rect, page_height),
            Some(stroke),
            Some(stroke_width(&annotation.style)),
            fill,
        )
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    Ok(())
}

fn draw_highlight(
    page: &mut PdfPage<'_>,
    annotation: &AnnotationData,
    page_height: f32,
) -> Result<(), PdfError> {
    let Some(rect) = annotation.rect else {
        return Ok(());
    };
    let fill = annotation
        .style
        .fill
        .as_deref()
        .filter(|value| !value.eq_ignore_ascii_case("transparent"))
        .unwrap_or(&annotation.style.color);

    page.objects_mut()
        .create_path_object_rect(
            rect_to_pdf(rect, page_height),
            None,
            None,
            Some(color_from_hex(fill, annotation.style.opacity)),
        )
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    Ok(())
}

fn draw_line_annotation(
    page: &mut PdfPage<'_>,
    annotation: &AnnotationData,
    page_height: f32,
    arrow: bool,
) -> Result<(), PdfError> {
    if annotation.points.len() < 2 {
        return Ok(());
    }
    let start = annotation.points[0];
    let end = annotation.points[1];
    draw_segment(page, start, end, &annotation.style, page_height)?;
    if arrow {
        draw_arrow_head(page, start, end, &annotation.style, page_height)?;
    }
    Ok(())
}

fn draw_polyline(
    page: &mut PdfPage<'_>,
    points: &[AnnotationPoint],
    style: &AnnotationStyle,
    page_height: f32,
) -> Result<(), PdfError> {
    for pair in points.windows(2) {
        draw_segment(page, pair[0], pair[1], style, page_height)?;
    }
    Ok(())
}

fn draw_segment(
    page: &mut PdfPage<'_>,
    start: AnnotationPoint,
    end: AnnotationPoint,
    style: &AnnotationStyle,
    page_height: f32,
) -> Result<(), PdfError> {
    let (x1, y1) = point_to_pdf(start, page_height);
    let (x2, y2) = point_to_pdf(end, page_height);
    let mut object = page
        .objects_mut()
        .create_path_object_line(
            x1,
            y1,
            x2,
            y2,
            color_from_hex(&style.color, style.opacity),
            stroke_width(style),
        )
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    object
        .set_line_cap(PdfPageObjectLineCap::Round)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    object
        .set_line_join(PdfPageObjectLineJoin::Round)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    Ok(())
}

fn draw_arrow_head(
    page: &mut PdfPage<'_>,
    start: AnnotationPoint,
    end: AnnotationPoint,
    style: &AnnotationStyle,
    page_height: f32,
) -> Result<(), PdfError> {
    let (x1, y1) = point_to_pdf(start, page_height);
    let (x2, y2) = point_to_pdf(end, page_height);
    let angle = (y2.value - y1.value).atan2(x2.value - x1.value);
    let size = (style.width * 4.0).max(8.0);

    for theta in [angle + 5.0 * PI / 6.0, angle - 5.0 * PI / 6.0] {
        let head = AnnotationPoint {
            x: x2.value + size * theta.cos(),
            y: page_height - (y2.value + size * theta.sin()),
        };
        draw_segment(
            page,
            AnnotationPoint {
                x: x2.value,
                y: page_height - y2.value,
            },
            head,
            style,
            page_height,
        )?;
    }

    Ok(())
}

fn rect_to_pdf(rect: AnnotationRect, page_height: f32) -> PdfRect {
    PdfRect::new_from_values(
        page_height - rect.y - rect.h,
        rect.x,
        page_height - rect.y,
        rect.x + rect.w,
    )
}

fn point_to_pdf(point: AnnotationPoint, page_height: f32) -> (PdfPoints, PdfPoints) {
    (
        PdfPoints::new(point.x),
        PdfPoints::new(page_height - point.y),
    )
}

fn stroke_width(style: &AnnotationStyle) -> PdfPoints {
    PdfPoints::new(style.width.max(0.5))
}

fn annotation_fill_color(style: &AnnotationStyle) -> Option<PdfColor> {
    style
        .fill
        .as_deref()
        .filter(|value| !value.eq_ignore_ascii_case("transparent"))
        .map(|value| color_from_hex(value, style.opacity))
}

fn color_from_hex(value: &str, opacity: f32) -> PdfColor {
    let raw = value.strip_prefix('#').unwrap_or(value);
    let opacity = if opacity.is_finite() {
        opacity.clamp(0.0, 1.0)
    } else {
        1.0
    };
    let alpha = (opacity * 255.0).round() as u8;

    if raw.len() == 6 {
        if let Ok(rgb) = u32::from_str_radix(raw, 16) {
            return PdfColor::new(
                ((rgb >> 16) & 0xff) as u8,
                ((rgb >> 8) & 0xff) as u8,
                (rgb & 0xff) as u8,
                alpha,
            );
        }
    }

    PdfColor::new(225, 29, 72, alpha)
}
