use super::cache::{CacheKey, PageCache};
use super::document::{DocHandle, DocRegistry};
use super::{create_pdfium, PdfError};
use pdfium_render::prelude::{PdfPageRenderRotation, PdfRenderConfig};
use std::sync::Arc;

const PT_TO_PX: f32 = 96.0 / 72.0; // CSS px per PDF point at zoom=1

fn rotation_from_degrees(deg: i32) -> PdfPageRenderRotation {
    match deg.rem_euclid(360) {
        90 => PdfPageRenderRotation::Degrees90,
        180 => PdfPageRenderRotation::Degrees180,
        270 => PdfPageRenderRotation::Degrees270,
        _ => PdfPageRenderRotation::None,
    }
}

/// Render a page to PNG bytes. `scale` is CSS-px-per-PDF-point divided by 1.333.
/// Result is cached keyed by (doc_id, page, scale_bucket, rotation).
pub fn render_page(
    registry: &DocRegistry,
    cache: &PageCache,
    doc_id: &str,
    page_index: usize,
    scale: f32,
    rotation_deg: i32,
) -> Result<Vec<u8>, PdfError> {
    let scale_bucket = (scale * 100.0).round() as u32;
    let rotation_bucket = rotation_deg.rem_euclid(360) as u16;
    let key = CacheKey {
        doc_id: doc_id.to_string(),
        page_index,
        scale_bucket,
        rotation: rotation_bucket,
    };

    if let Some(cached) = cache.get(&key) {
        return Ok(cached.as_ref().clone());
    }

    let handle: Arc<DocHandle> = registry.get(doc_id)?;
    if page_index >= handle.page_count {
        return Err(PdfError::InvalidPage(page_index));
    }

    let pdfium = create_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let pixel_scale = scale * PT_TO_PX;
    let target_w = (page.width().value * pixel_scale).max(1.0) as i32;
    let target_h = (page.height().value * pixel_scale).max(1.0) as i32;

    let render_config = PdfRenderConfig::new()
        .set_target_width(target_w)
        .set_target_height(target_h)
        .rotate(rotation_from_degrees(rotation_deg), false);

    let bitmap = page
        .render_with_config(&render_config)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let rgba = bitmap.as_image().into_rgba8();
    let (w, h) = rgba.dimensions();
    let pixels = rgba.as_raw();

    // Skip PNG encoding entirely: encoding a high-zoom page can take longer
    // than rendering it. We ship raw RGBA over the Tauri IPC `Response` —
    // the cost on the wire is one memcpy, and the frontend draws via
    // `putImageData` (no PNG decode either). Layout: 8-byte big-endian
    // header (u32 width, u32 height) followed by w*h*4 bytes of RGBA.
    let mut buf = Vec::with_capacity(8 + pixels.len());
    buf.extend_from_slice(&(w as u32).to_be_bytes());
    buf.extend_from_slice(&(h as u32).to_be_bytes());
    buf.extend_from_slice(pixels);

    let arc = Arc::new(buf.clone());
    cache.put(key, arc, buf.len());
    Ok(buf)
}
