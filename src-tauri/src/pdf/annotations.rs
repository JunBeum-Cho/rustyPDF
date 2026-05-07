use super::rich_text::{parse_html, RunStyle, TextLine, TextRun};
use super::{create_pdfium, PdfError};
use pdfium_render::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
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
    /// Load only the 14 built-in PDF fonts. CJK is deferred to
    /// [`ensure_cjk`], which subsets a system font on demand based on the
    /// chars actually used in annotations — embedding the full 30 MB
    /// AppleSDGothicNeo.ttc unconditionally was the cause of 60 MB exports.
    fn load_builtin(document: &mut PdfDocument) -> Self {
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
            cjk: None,
            cjk_bold: None,
        }
    }

    /// Subset + embed a system CJK font covering `used_chars`. No-op if the
    /// set is empty (export contains no non-ASCII text) or if no candidate
    /// system font is installed. We embed exactly one face and reuse it
    /// for the bold slot too — the prior code listed AppleSDGothicNeo.ttc
    /// for both regular and bold and pdfium picked the same internal face
    /// either way, so visually nothing changes.
    fn ensure_cjk(&mut self, document: &mut PdfDocument, used_chars: &BTreeSet<char>) {
        if used_chars.is_empty() {
            return;
        }
        // Order: Korean-specific first (smaller subsets, better hinting),
        // then pan-CJK Noto. We only need ONE that loads.
        const CJK_CANDIDATES: &[&str] = &[
            r"C:\Windows\Fonts\malgun.ttf",
            r"C:\Windows\Fonts\NanumGothic.ttf",
            "/System/Library/Fonts/AppleSDGothicNeo.ttc",
            "/Library/Fonts/AppleSDGothicNeo.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        ];
        for path in CJK_CANDIDATES {
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            if let Some(token) = subset_and_load(document, &bytes, used_chars) {
                self.cjk = Some(token);
                self.cjk_bold = Some(token);
                return;
            }
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

/// Subset `font_bytes` to cover only `used_chars`, then embed the trimmed
/// TrueType into `document`. Returns `None` if the font fails to parse,
/// none of the requested chars resolve to glyphs, or pdfium rejects the
/// resulting bytes — callers fall through to the next candidate font.
///
/// Face index is hard-coded to 0; for `.ttc` collections this picks the
/// first face, which matches what pdfium's previous direct-load path did
/// anyway. `GlyphRemapper` rewrites glyph IDs into a contiguous range and
/// rebuilds the cmap accordingly, so pdfium's Unicode → glyph lookup
/// resolves to the new IDs.
fn subset_and_load(
    document: &mut PdfDocument,
    font_bytes: &[u8],
    used_chars: &BTreeSet<char>,
) -> Option<PdfFontToken> {
    const FACE_INDEX: u32 = 0;
    let face = ttf_parser::Face::parse(font_bytes, FACE_INDEX).ok()?;
    let mut remapper = subsetter::GlyphRemapper::new();
    let mut found = false;
    for &c in used_chars {
        if let Some(gid) = face.glyph_index(c) {
            remapper.remap(gid.0);
            found = true;
        }
    }
    if !found {
        return None;
    }
    let subset = subsetter::subset(font_bytes, FACE_INDEX, &remapper).ok()?;
    document
        .fonts_mut()
        .load_true_type_from_bytes(&subset, true)
        .ok()
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
    /// Editor's rich-text HTML. Optional — annotations without per-range
    /// styling (or written by an older client) just pass `text`.
    #[serde(default)]
    html: Option<String>,
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
    let mut fonts = ExportFonts::load_builtin(&mut document);
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

    // Pre-scan all text annotations for non-ASCII chars so we know which
    // glyphs the CJK subset needs. Text content lives in either the
    // editor's HTML (rich text) or the legacy plain-text fallback; we
    // sweep both fields raw — non-ASCII HTML tag chars don't exist, so
    // the resulting set is exactly the displayed characters.
    let cjk_chars: BTreeSet<char> = annotations_by_page
        .values()
        .flatten()
        .filter(|a| matches!(a.kind, AnnotationKind::Text))
        .flat_map(|a| {
            let html_chars = a.payload.html.as_deref().unwrap_or("").chars();
            let text_chars = a.payload.text.chars();
            html_chars.chain(text_chars)
        })
        .filter(|c| (*c as u32) > 127)
        .collect();
    fonts.ensure_cjk(&mut document, &cjk_chars);

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

/// Render a text annotation as flattened page objects. When `payload.html`
/// is present we walk it via `rich_text::parse_html` so per-range bold /
/// italic / underline / font-family / font-size / color carry into the
/// PDF as separate text objects within each line. Falling back to
/// `payload.text` (newline-split, single annotation-level style) keeps
/// older sidecars and any annotation that never picked up rich-text
/// editing working.
fn draw_text(
    page: &mut PdfPage<'_>,
    annotation: &AnnotationData,
    page_height: f32,
    fonts: &ExportFonts,
) -> Result<(), PdfError> {
    let Some(rect) = annotation.rect else {
        return Ok(());
    };
    let style = &annotation.style;
    let base_font_size = style.font_size.max(1.0);

    let base = RunStyle {
        color: style.color.clone(),
        opacity: style.opacity,
        font_size: base_font_size,
        font_family: style.font_family.clone(),
        bold: is_bold_style(style),
        italic: is_italic_style(style),
        underline: is_underline_style(style),
    };

    let lines = match annotation.payload.html.as_deref() {
        Some(html) if !html.trim().is_empty() => parse_html(html, base.clone()),
        _ => fallback_lines_from_text(&annotation.payload.text, &base),
    };

    if lines.is_empty() || lines.iter().all(|l| l.runs.is_empty()) {
        return Ok(());
    }

    // CJK font selection is annotation-wide so visually adjacent runs
    // share metrics — mixing built-in Helvetica with Malgun Gothic in
    // the same line would jitter heights even when both have Latin
    // glyphs available.
    let annotation_has_cjk = lines
        .iter()
        .flat_map(|l| l.runs.iter())
        .any(|r| r.text.chars().any(|c| (c as u32) > 127));

    let align = align_kind(style);

    // Walk each visual line, place runs left-to-right, advance baseline by
    // (line's tallest run's font_size * 1.25).
    let mut current_y = page_height - rect.y - base_font_size;

    for line in lines {
        let runs: Vec<TextRun> = line.runs.into_iter().filter(|r| !r.text.is_empty()).collect();
        if runs.is_empty() {
            // Visible blank line — still advance so the rhythm matches
            // what the user typed.
            current_y -= base_font_size * 1.25;
            continue;
        }

        let line_max_size = runs
            .iter()
            .map(|r| r.style.font_size)
            .fold(0f32, f32::max)
            .max(base_font_size);

        // Stage 1 — create each run at the origin so we can ask pdfium for
        // its width. The objects are owned by the page from this point;
        // dropping the Rust handle does NOT remove them (see the Drop impl
        // for PdfPageObject), it just releases the local reference.
        let mut placed: Vec<(PdfPageObject<'_>, f32, RunStyle)> = Vec::with_capacity(runs.len());
        let mut total_width = 0.0;
        for run in runs {
            let token = fonts.pick(
                run.style.font_family.as_deref(),
                run.style.bold,
                run.style.italic,
                annotation_has_cjk,
            );
            let mut object = page
                .objects_mut()
                .create_text_object(
                    PdfPoints::ZERO,
                    PdfPoints::ZERO,
                    &run.text,
                    token,
                    PdfPoints::new(run.style.font_size.max(1.0)),
                )
                .map_err(|e| PdfError::Pdfium(e.to_string()))?;
            object
                .set_fill_color(color_from_hex(&run.style.color, run.style.opacity))
                .map_err(|e| PdfError::Pdfium(e.to_string()))?;
            let width = object
                .width()
                .map(|w| w.value)
                .unwrap_or_else(|_| {
                    run.style.font_size * 0.55 * run.text.chars().count() as f32
                });
            total_width += width;
            placed.push((object, width, run.style));
        }

        // Stage 2 — alignment offset within the rect.
        let line_x = match align {
            "center" => rect.x + (rect.w - total_width) / 2.0,
            "right" => rect.x + rect.w - total_width,
            _ => rect.x,
        };
        let baseline_y = current_y;

        // Stage 3 — translate each run to its final position and draw any
        // per-run underline. Underlines are stroked paths added AFTER the
        // last text translate so the page.objects_mut() borrow is fresh.
        let mut cursor = 0.0_f32;
        let mut underline_specs: Vec<(f32, f32, f32, f32, PdfColor)> = Vec::new();
        for (mut object, width, run_style) in placed {
            let x = line_x + cursor;
            object
                .translate(PdfPoints::new(x), PdfPoints::new(baseline_y))
                .map_err(|e| PdfError::Pdfium(e.to_string()))?;

            if run_style.underline {
                let underline_y = baseline_y - run_style.font_size * 0.12;
                let thickness = (run_style.font_size * 0.06).max(0.5);
                underline_specs.push((
                    x,
                    x + width,
                    underline_y,
                    thickness,
                    color_from_hex(&run_style.color, run_style.opacity),
                ));
            }
            cursor += width;
            // Drop `object` here — the actual PDF text object stays on
            // the page; only the local reference goes away.
        }

        for (x1, x2, y, thickness, color) in underline_specs {
            page.objects_mut()
                .create_path_object_line(
                    PdfPoints::new(x1),
                    PdfPoints::new(y),
                    PdfPoints::new(x2),
                    PdfPoints::new(y),
                    color,
                    PdfPoints::new(thickness),
                )
                .map_err(|e| PdfError::Pdfium(e.to_string()))?;
        }

        current_y -= line_max_size * 1.25;
    }

    Ok(())
}

fn fallback_lines_from_text(text: &str, base: &RunStyle) -> Vec<TextLine> {
    text.split('\n')
        .map(|line| TextLine {
            runs: vec![TextRun {
                text: line.to_string(),
                style: base.clone(),
            }],
        })
        .collect()
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
