use super::cache::PageCache;
use super::document::{DocHandle, DocRegistry, OpenedDocument, PageMeta};
use super::text::TextCache;
use super::{create_pdfium, PdfError};
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

/// In-memory page clipboard. Each entry is a self-contained PDF whose pages
/// are the user's clipboard contents. Clearing isn't automatic — the user
/// pastes when they're ready, and entries are short-lived because most users
/// paste within a few seconds. We cap by count to avoid runaway memory.
const CLIPBOARD_MAX_ENTRIES: usize = 16;

pub struct PageClipboard {
    inner: RwLock<HashMap<String, Arc<Vec<u8>>>>,
    order: RwLock<Vec<String>>,
}

impl PageClipboard {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            order: RwLock::new(Vec::new()),
        }
    }

    pub fn put(&self, bytes: Vec<u8>) -> String {
        let id = Uuid::new_v4().to_string();
        let bytes = Arc::new(bytes);
        {
            let mut map = self.inner.write();
            let mut order = self.order.write();
            map.insert(id.clone(), bytes);
            order.push(id.clone());
            while order.len() > CLIPBOARD_MAX_ENTRIES {
                let evicted = order.remove(0);
                map.remove(&evicted);
            }
        }
        id
    }

    pub fn get(&self, id: &str) -> Option<Arc<Vec<u8>>> {
        self.inner.read().get(id).cloned()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageEditResult {
    pub id: String,
    pub path: String,
    pub page_count: usize,
    pub pages: Vec<PageMeta>,
    pub file_size: u64,
    /// `mapping[old_index]` → new index, or null if removed.
    pub page_mapping: Vec<Option<usize>>,
}

/// Convert zero-based indices into pdfium's 1-based page-range string.
/// Sorts and deduplicates because the underlying pdfium import preserves the
/// order in the string and the frontend may pass indices in click order.
fn indices_to_range_string(indices: &[usize]) -> String {
    let mut sorted: Vec<usize> = indices.iter().copied().collect();
    sorted.sort_unstable();
    sorted.dedup();
    sorted
        .iter()
        .map(|i| (i + 1).to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn collect_page_meta(doc: &pdfium_render::prelude::PdfDocument) -> Vec<PageMeta> {
    let mut pages = Vec::new();
    let pages_iter = doc.pages();
    for (i, page) in pages_iter.iter().enumerate() {
        pages.push(PageMeta {
            index: i,
            width: page.width().value,
            height: page.height().value,
        });
    }
    pages
}

fn replace_handle(
    registry: &DocRegistry,
    cache: &PageCache,
    text: &TextCache,
    doc_id: &str,
    bytes: Vec<u8>,
    pages: Vec<PageMeta>,
    path: String,
) -> Result<OpenedDocument, PdfError> {
    let file_size = bytes.len() as u64;
    let page_count = pages.len();
    let new_handle = DocHandle {
        path: path.clone(),
        bytes: Arc::new(bytes),
        page_count,
        pages: pages.clone(),
    };
    registry.replace(doc_id, new_handle)?;
    cache.purge_doc(doc_id);
    text.invalidate(doc_id);
    Ok(OpenedDocument {
        id: doc_id.to_string(),
        path,
        page_count,
        pages,
        file_size,
    })
}

pub fn delete_pages(
    registry: &DocRegistry,
    cache: &PageCache,
    text: &TextCache,
    doc_id: &str,
    indices: &[usize],
) -> Result<PdfPageEditResult, PdfError> {
    let handle = registry.get(doc_id)?;
    let mut to_delete: Vec<usize> = indices.iter().copied().collect();
    to_delete.sort_unstable();
    to_delete.dedup();
    if to_delete.is_empty() {
        return Err(PdfError::Pdfium("no pages selected".into()));
    }
    if to_delete.iter().any(|&i| i >= handle.page_count) {
        return Err(PdfError::InvalidPage(*to_delete.last().unwrap()));
    }
    if to_delete.len() >= handle.page_count {
        return Err(PdfError::Pdfium("cannot delete every page".into()));
    }

    let pdfium = create_pdfium()?;
    let mut doc = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    // Delete from highest index first so earlier indices stay valid.
    for &idx in to_delete.iter().rev() {
        let page = doc
            .pages()
            .get(idx as u16)
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;
        page.delete()
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    }

    let bytes = doc
        .save_to_bytes()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let pages = collect_page_meta(&doc);
    drop(doc);
    drop(pdfium);

    let opened = replace_handle(
        registry,
        cache,
        text,
        doc_id,
        bytes,
        pages,
        handle.path.clone(),
    )?;

    let mut mapping: Vec<Option<usize>> = Vec::with_capacity(handle.page_count);
    let deleted_set: std::collections::HashSet<usize> = to_delete.iter().copied().collect();
    let mut next = 0usize;
    for old in 0..handle.page_count {
        if deleted_set.contains(&old) {
            mapping.push(None);
        } else {
            mapping.push(Some(next));
            next += 1;
        }
    }

    Ok(PdfPageEditResult {
        id: opened.id,
        path: opened.path,
        page_count: opened.page_count,
        pages: opened.pages,
        file_size: opened.file_size,
        page_mapping: mapping,
    })
}

pub fn copy_pages_to_clipboard(
    registry: &DocRegistry,
    clipboard: &PageClipboard,
    doc_id: &str,
    indices: &[usize],
) -> Result<String, PdfError> {
    let handle = registry.get(doc_id)?;
    let mut sorted: Vec<usize> = indices.iter().copied().collect();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.is_empty() {
        return Err(PdfError::Pdfium("no pages selected".into()));
    }
    if sorted.iter().any(|&i| i >= handle.page_count) {
        return Err(PdfError::InvalidPage(*sorted.last().unwrap()));
    }

    let pdfium = create_pdfium()?;
    let source = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let mut clip = pdfium
        .create_new_pdf()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let range = indices_to_range_string(&sorted);
    clip.pages_mut()
        .copy_pages_from_document(&source, &range, 0)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let bytes = clip
        .save_to_bytes()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let token = clipboard.put(bytes);
    Ok(token)
}

pub fn paste_pages(
    registry: &DocRegistry,
    cache: &PageCache,
    text: &TextCache,
    clipboard: &PageClipboard,
    doc_id: &str,
    after_index: i64,
    clipboard_id: &str,
) -> Result<PdfPageEditResult, PdfError> {
    let handle = registry.get(doc_id)?;
    let clip_bytes = clipboard
        .get(clipboard_id)
        .ok_or_else(|| PdfError::Pdfium("clipboard expired".into()))?;

    let pdfium = create_pdfium()?;
    let mut target = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let source = pdfium
        .load_pdf_from_byte_slice(&clip_bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let source_count = source.pages().len() as usize;
    if source_count == 0 {
        return Err(PdfError::Pdfium("clipboard is empty".into()));
    }

    // -1 → paste at start. Otherwise paste *after* the given index, i.e. at after_index+1.
    let dest_index: u16 = if after_index < 0 {
        0
    } else {
        let idx = (after_index as usize + 1).min(handle.page_count);
        idx as u16
    };

    // Build "1-N" range string covering all pages of the clipboard doc.
    let range = format!("1-{}", source_count);
    target
        .pages_mut()
        .copy_pages_from_document(&source, &range, dest_index)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let bytes = target
        .save_to_bytes()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let pages = collect_page_meta(&target);
    drop(target);
    drop(source);
    drop(pdfium);

    let opened = replace_handle(
        registry,
        cache,
        text,
        doc_id,
        bytes,
        pages,
        handle.path.clone(),
    )?;

    // mapping: old i ≤ dest_index → unchanged; old i > dest_index → shift by source_count
    let dest = dest_index as usize;
    let mut mapping = Vec::with_capacity(handle.page_count);
    for old in 0..handle.page_count {
        if old < dest {
            mapping.push(Some(old));
        } else {
            mapping.push(Some(old + source_count));
        }
    }

    Ok(PdfPageEditResult {
        id: opened.id,
        path: opened.path,
        page_count: opened.page_count,
        pages: opened.pages,
        file_size: opened.file_size,
        page_mapping: mapping,
    })
}

pub fn duplicate_pages(
    registry: &DocRegistry,
    cache: &PageCache,
    text: &TextCache,
    doc_id: &str,
    indices: &[usize],
) -> Result<PdfPageEditResult, PdfError> {
    let handle = registry.get(doc_id)?;
    let mut sorted: Vec<usize> = indices.iter().copied().collect();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.is_empty() {
        return Err(PdfError::Pdfium("no pages selected".into()));
    }
    if sorted.iter().any(|&i| i >= handle.page_count) {
        return Err(PdfError::InvalidPage(*sorted.last().unwrap()));
    }

    let pdfium = create_pdfium()?;
    let mut target = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    // Copy source from a fresh load so we're not mutating-while-reading.
    let source = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let last = *sorted.last().unwrap();
    let dest_index = (last + 1) as u16;
    let range = indices_to_range_string(&sorted);
    target
        .pages_mut()
        .copy_pages_from_document(&source, &range, dest_index)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let bytes = target
        .save_to_bytes()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let pages = collect_page_meta(&target);
    let inserted = sorted.len();
    drop(target);
    drop(source);
    drop(pdfium);

    let opened = replace_handle(
        registry,
        cache,
        text,
        doc_id,
        bytes,
        pages,
        handle.path.clone(),
    )?;

    let dest = dest_index as usize;
    let mut mapping = Vec::with_capacity(handle.page_count);
    for old in 0..handle.page_count {
        if old < dest {
            mapping.push(Some(old));
        } else {
            mapping.push(Some(old + inserted));
        }
    }

    Ok(PdfPageEditResult {
        id: opened.id,
        path: opened.path,
        page_count: opened.page_count,
        pages: opened.pages,
        file_size: opened.file_size,
        page_mapping: mapping,
    })
}

/// Save the current in-memory bytes of a doc to the given filesystem path.
/// Used after page edits so users can persist changes (Acrobat-style "save as").
pub fn save_doc_as(registry: &DocRegistry, doc_id: &str, target_path: &str) -> Result<(), PdfError> {
    let handle = registry.get(doc_id)?;
    std::fs::write(target_path, handle.bytes.as_ref())?;
    Ok(())
}

/// Render a rectangular region of the given page to PNG bytes. Coordinates
/// are in PDF points (origin = top-left of the page). The caller usually
/// derives them from the on-screen drag rectangle by inverting the current
/// zoom / rotation (the same `displayPointToPage` function the annotation
/// layer uses) — the backend just renders at a high enough scale and crops.
/// `scale` controls output pixel density: 1.0 = 96dpi web-equivalent ≈
/// 132dpi, 2.0 ≈ retina, 3.0 = print-quality. The frontend picks based on
/// the use case (default 2.0 in `capture.ts`).
pub fn capture_region(
    registry: &DocRegistry,
    doc_id: &str,
    page_index: usize,
    x_pts: f32,
    y_pts: f32,
    w_pts: f32,
    h_pts: f32,
    scale: f32,
) -> Result<Vec<u8>, PdfError> {
    use pdfium_render::prelude::PdfRenderConfig;

    let handle = registry.get(doc_id)?;
    if page_index >= handle.page_count {
        return Err(PdfError::InvalidPage(page_index));
    }
    if w_pts <= 0.0 || h_pts <= 0.0 {
        return Err(PdfError::Pdfium("capture region has zero area".into()));
    }

    let pdfium = super::create_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let page_w_pts = page.width().value;
    let page_h_pts = page.height().value;

    // Render the entire page at the requested scale, then crop.
    // Cropping a render is cheap relative to running pdfium, so we don't
    // bother with pdfium's own clip-rect setting (the API surface is
    // version-sensitive and renderConfig clipping doesn't shrink the
    // output buffer — it just ignores ink outside the rect).
    const PT_TO_PX: f32 = 96.0 / 72.0;
    let pixel_scale = scale * PT_TO_PX;
    let target_w = (page_w_pts * pixel_scale).round() as i32;
    let target_h = (page_h_pts * pixel_scale).round() as i32;

    let render_config = PdfRenderConfig::new()
        .set_target_width(target_w)
        .set_target_height(target_h);
    let bitmap = page
        .render_with_config(&render_config)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let rgba_full = bitmap.as_image().into_rgba8();

    // Convert PDF-points rect → output-pixel rect, clamping to image bounds.
    let crop_x = ((x_pts * pixel_scale).round() as i64).max(0) as u32;
    let crop_y = ((y_pts * pixel_scale).round() as i64).max(0) as u32;
    let crop_w = ((w_pts * pixel_scale).round() as i64).max(1) as u32;
    let crop_h = ((h_pts * pixel_scale).round() as i64).max(1) as u32;
    let max_w = rgba_full.width().saturating_sub(crop_x);
    let max_h = rgba_full.height().saturating_sub(crop_y);
    let final_w = crop_w.min(max_w);
    let final_h = crop_h.min(max_h);
    if final_w == 0 || final_h == 0 {
        return Err(PdfError::Pdfium(
            "capture region falls outside page bounds".into(),
        ));
    }

    let cropped = image::imageops::crop_imm(&rgba_full, crop_x, crop_y, final_w, final_h)
        .to_image();

    let mut out: Vec<u8> = Vec::with_capacity((final_w * final_h * 4) as usize);
    cropped
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Png,
        )
        .map_err(|e| PdfError::Image(e.to_string()))?;
    Ok(out)
}
