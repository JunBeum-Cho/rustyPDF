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

fn rotated_page_size(width: f32, height: f32, rotation_deg: i32) -> (f32, f32) {
    if matches!(rotation_deg.rem_euclid(360), 90 | 270) {
        (height, width)
    } else {
        (width, height)
    }
}

/// Render a page to PNG bytes. `scale` is CSS-px-per-PDF-point divided by 1.333.
/// Result is cached by document revision, page, scale bucket, and rotation.
pub fn render_page(
    registry: &DocRegistry,
    cache: &PageCache,
    doc_id: &str,
    expected_revision: u64,
    page_index: usize,
    scale: f32,
    rotation_deg: i32,
) -> Result<Vec<u8>, PdfError> {
    // `scale` arrives from the frontend; guard against non-finite or absurd
    // values so the cache bucket and the render target stay sane.
    let scale = if scale.is_finite() && scale > 0.0 {
        scale.min(16.0)
    } else {
        1.0
    };
    let handle: Arc<DocHandle> = registry.get_at_revision(doc_id, expected_revision)?;
    if page_index >= handle.page_count {
        return Err(PdfError::InvalidPage(page_index));
    }

    let scale_bucket = (scale * 100.0).round() as u32;
    let rotation_bucket = rotation_deg.rem_euclid(360) as u16;
    let key = CacheKey {
        doc_id: doc_id.to_string(),
        revision: handle.revision,
        page_index,
        scale_bucket,
        rotation: rotation_bucket,
    };

    if let Some(cached) = cache.get(&key) {
        let current = registry.get(doc_id)?;
        if Arc::ptr_eq(&current, &handle) {
            return Ok(cached.as_ref().clone());
        }
        return Err(PdfError::StaleDocument {
            expected: expected_revision,
            actual: current.revision,
        });
    }

    let pdfium = create_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let mut pixel_scale = scale * PT_TO_PX;
    let (display_w, display_h) =
        rotated_page_size(page.width().value, page.height().value, rotation_deg);
    if !display_w.is_finite() || !display_h.is_finite() || display_w <= 0.0 || display_h <= 0.0 {
        return Err(PdfError::Pdfium("page has invalid dimensions".into()));
    }
    // A malicious PDF can declare an enormous MediaBox. Cap the output so we
    // never ask pdfium for a multi-gigapixel bitmap (OOM/abort). Scale both
    // axes down together to preserve aspect ratio.
    const MAX_DIM: f32 = 10_000.0;
    let over = (display_w * pixel_scale / MAX_DIM).max(display_h * pixel_scale / MAX_DIM);
    if over > 1.0 {
        pixel_scale /= over;
    }
    const MAX_PIXELS: f32 = 32_000_000.0;
    let pixel_count = display_w * display_h * pixel_scale * pixel_scale;
    if pixel_count > MAX_PIXELS {
        pixel_scale *= (MAX_PIXELS / pixel_count).sqrt();
    }
    let target_w = (display_w * pixel_scale).max(1.0) as i32;
    let target_h = (display_h * pixel_scale).max(1.0) as i32;

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

    // Only populate the cache if the document wasn't replaced while this
    // render was in flight. The key also carries the revision, making a stale
    // insertion unreachable even in the tiny check/put race window.
    let current = registry.get(doc_id)?;
    if !Arc::ptr_eq(&current, &handle) {
        return Err(PdfError::StaleDocument {
            expected: expected_revision,
            actual: current.revision,
        });
    }
    let arc = Arc::new(buf.clone());
    cache.put(key, arc, buf.len());
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::rotated_page_size;

    #[test]
    fn swaps_render_axes_only_for_quarter_turns() {
        assert_eq!(rotated_page_size(612.0, 792.0, 0), (612.0, 792.0));
        assert_eq!(rotated_page_size(612.0, 792.0, 90), (792.0, 612.0));
        assert_eq!(rotated_page_size(612.0, 792.0, 180), (612.0, 792.0));
        assert_eq!(rotated_page_size(612.0, 792.0, 270), (792.0, 612.0));
        assert_eq!(rotated_page_size(612.0, 792.0, -90), (792.0, 612.0));
    }
}
