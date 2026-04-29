use super::{create_pdfium, PdfError};
use pdfium_render::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::f32::consts::PI;
use std::path::Path;

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
}

impl Default for AnnotationStyle {
    fn default() -> Self {
        Self {
            color: default_color(),
            width: default_width(),
            fill: None,
            opacity: default_opacity(),
            font_size: default_font_size(),
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
    let font = document.fonts_mut().helvetica();
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
            draw_annotation(&mut page, &annotation, page_height, font)?;
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
    font: PdfFontToken,
) -> Result<(), PdfError> {
    match annotation.kind {
        AnnotationKind::Text => draw_text(page, annotation, page_height, font),
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

fn draw_text(
    page: &mut PdfPage<'_>,
    annotation: &AnnotationData,
    page_height: f32,
    font: PdfFontToken,
) -> Result<(), PdfError> {
    let Some(rect) = annotation.rect else {
        return Ok(());
    };
    if annotation.payload.text.trim().is_empty() {
        return Ok(());
    }

    let font_size = annotation.style.font_size.max(1.0);
    let color = color_from_hex(&annotation.style.color, annotation.style.opacity);
    let mut object = page
        .objects_mut()
        .create_text_object(
            PdfPoints::new(rect.x),
            PdfPoints::new(page_height - rect.y - font_size),
            &annotation.payload.text,
            font,
            PdfPoints::new(font_size),
        )
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    object
        .set_fill_color(color)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
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
