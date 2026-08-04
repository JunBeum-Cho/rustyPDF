use super::annotations::flatten_pdf_bytes;
use super::cache::PageCache;
use super::document::{
    collect_page_meta, paths_refer_to_same_file, DocHandle, DocRegistry, OpenedDocument, PageMeta,
};
use super::text::TextCache;
use super::{create_pdfium, PdfError};
use crate::storage::{atomic_write, sha256_hex};
use parking_lot::RwLock;
use pdfium_render::prelude::PdfPageRenderRotation;
use serde::Serialize;
use serde_json::Value;
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
    pub revision: u64,
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

fn replace_handle(
    registry: &DocRegistry,
    cache: &PageCache,
    text: &TextCache,
    doc_id: &str,
    current: &Arc<DocHandle>,
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
        disk_fingerprint: current.disk_fingerprint.clone(),
        revision: current.revision + 1,
    };
    registry.replace_if_current(doc_id, current, new_handle)?;
    cache.purge_doc(doc_id);
    text.invalidate(doc_id);
    Ok(OpenedDocument {
        id: doc_id.to_string(),
        revision: current.revision + 1,
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
    expected_revision: u64,
    indices: &[usize],
) -> Result<PdfPageEditResult, PdfError> {
    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
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
    let doc = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    // Delete from highest index first so earlier indices stay valid.
    for &idx in to_delete.iter().rev() {
        let page = doc
            .pages()
            .get(idx as u16)
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;
        page.delete().map_err(|e| PdfError::Pdfium(e.to_string()))?;
    }

    let bytes = doc
        .save_to_bytes()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let pages = collect_page_meta(&doc)?;
    drop(doc);
    drop(pdfium);

    let opened = replace_handle(
        registry,
        cache,
        text,
        doc_id,
        &handle,
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
        revision: opened.revision,
        path: opened.path,
        page_count: opened.page_count,
        pages: opened.pages,
        file_size: opened.file_size,
        page_mapping: mapping,
    })
}

fn rotate_quarter_turn(rotation: PdfPageRenderRotation, direction: i8) -> PdfPageRenderRotation {
    let current = match rotation {
        PdfPageRenderRotation::None => 0_i8,
        PdfPageRenderRotation::Degrees90 => 1,
        PdfPageRenderRotation::Degrees180 => 2,
        PdfPageRenderRotation::Degrees270 => 3,
    };
    match (current + direction).rem_euclid(4) {
        1 => PdfPageRenderRotation::Degrees90,
        2 => PdfPageRenderRotation::Degrees180,
        3 => PdfPageRenderRotation::Degrees270,
        _ => PdfPageRenderRotation::None,
    }
}

/// Persistently rotate the selected PDF pages by one quarter-turn. This
/// updates each page's intrinsic `/Rotate` entry rather than applying a
/// transient renderer-only transform, so saves and later opens preserve it.
pub fn rotate_pages(
    registry: &DocRegistry,
    cache: &PageCache,
    text: &TextCache,
    doc_id: &str,
    expected_revision: u64,
    indices: &[usize],
    direction: i8,
) -> Result<PdfPageEditResult, PdfError> {
    if !matches!(direction, -1 | 1) {
        return Err(PdfError::Pdfium(
            "rotation direction must be -1 or 1".into(),
        ));
    }

    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
    let mut selected: Vec<usize> = indices.iter().copied().collect();
    selected.sort_unstable();
    selected.dedup();
    if selected.is_empty() {
        return Err(PdfError::Pdfium("no pages selected".into()));
    }
    if selected.iter().any(|&index| index >= handle.page_count) {
        return Err(PdfError::InvalidPage(*selected.last().unwrap()));
    }

    let pdfium = create_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(&handle.bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    for index in selected {
        let mut page = doc
            .pages()
            .get(index as u16)
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;
        let current = page
            .rotation()
            .map_err(|e| PdfError::Pdfium(e.to_string()))?;
        page.set_rotation(rotate_quarter_turn(current, direction));
    }

    let bytes = doc
        .save_to_bytes()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    drop(doc);

    // Reload once before publishing the edit result. Pdfium updates page
    // dimensions for `/Rotate`, and reopening also verifies the serialized
    // bytes are exactly what subsequent render calls will observe.
    let reloaded = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    let pages = collect_page_meta(&reloaded)?;
    drop(reloaded);
    drop(pdfium);

    let opened = replace_handle(
        registry,
        cache,
        text,
        doc_id,
        &handle,
        bytes,
        pages,
        handle.path.clone(),
    )?;

    Ok(PdfPageEditResult {
        id: opened.id,
        revision: opened.revision,
        path: opened.path,
        page_count: opened.page_count,
        pages: opened.pages,
        file_size: opened.file_size,
        page_mapping: (0..handle.page_count).map(Some).collect(),
    })
}

pub fn copy_pages_to_clipboard(
    registry: &DocRegistry,
    clipboard: &PageClipboard,
    doc_id: &str,
    expected_revision: u64,
    indices: &[usize],
) -> Result<String, PdfError> {
    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
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
    expected_revision: u64,
    after_index: i64,
    clipboard_id: &str,
) -> Result<PdfPageEditResult, PdfError> {
    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
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
        let idx = (after_index as usize)
            .saturating_add(1)
            .min(handle.page_count);
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
    let pages = collect_page_meta(&target)?;
    drop(target);
    drop(source);
    drop(pdfium);

    let opened = replace_handle(
        registry,
        cache,
        text,
        doc_id,
        &handle,
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
        revision: opened.revision,
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
    expected_revision: u64,
    indices: &[usize],
) -> Result<PdfPageEditResult, PdfError> {
    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
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
    let pages = collect_page_meta(&target)?;
    let inserted = sorted.len();
    drop(target);
    drop(source);
    drop(pdfium);

    let opened = replace_handle(
        registry,
        cache,
        text,
        doc_id,
        &handle,
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
        revision: opened.revision,
        path: opened.path,
        page_count: opened.page_count,
        pages: opened.pages,
        file_size: opened.file_size,
        page_mapping: mapping,
    })
}

/// Save the current in-memory bytes of a doc to the given filesystem path.
/// Used after page edits so users can persist changes (Acrobat-style "save as").
#[cfg(test)]
pub fn save_doc_as(
    registry: &DocRegistry,
    doc_id: &str,
    expected_revision: u64,
    target_path: &str,
) -> Result<OpenedDocument, PdfError> {
    save_doc_with_annotations(
        registry,
        doc_id,
        expected_revision,
        target_path,
        None,
        |_| Ok(()),
    )
}

/// Save the current in-memory document to disk, optionally flattening
/// annotations/images directly into the PDF bytes before writing. The
/// registry handle is replaced either way so subsequent renders use the exact
/// bytes that were just saved.
pub fn save_doc_with_annotations<F>(
    registry: &DocRegistry,
    doc_id: &str,
    expected_revision: u64,
    target_path: &str,
    data: Option<Value>,
    before_pdf_commit: F,
) -> Result<OpenedDocument, PdfError>
where
    F: FnOnce(&[u8]) -> Result<(), PdfError>,
{
    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
    if registry.path_is_open(target_path, Some(doc_id)) {
        return Err(PdfError::OpenDocumentConflict(target_path.to_string()));
    }
    verify_save_target_unchanged(&handle, target_path)?;
    let bytes = match data {
        Some(data) => flatten_pdf_bytes(handle.bytes.as_ref(), data)?,
        None => handle.bytes.as_ref().clone(),
    };
    // Metadata for these exact bytes is staged before the PDF replacement.
    // If the process stops between the two commits, either the old PDF still
    // finds its old fingerprint sidecar or the new PDF finds this staged one.
    before_pdf_commit(&bytes)?;
    // Recheck after flattening and sidecar staging, immediately before the
    // atomic replacement, to narrow the window for an external editor race.
    verify_save_target_unchanged(&handle, target_path)?;
    atomic_write(target_path, &bytes)?;

    let pages = handle.pages.clone();
    let page_count = handle.page_count;
    let file_size = bytes.len() as u64;
    let disk_fingerprint = sha256_hex(&bytes);
    let new_handle = DocHandle {
        path: target_path.to_string(),
        bytes: Arc::new(bytes),
        page_count,
        pages: pages.clone(),
        disk_fingerprint,
        revision: handle.revision + 1,
    };
    registry.replace_if_current(doc_id, &handle, new_handle)?;

    Ok(OpenedDocument {
        id: doc_id.to_string(),
        revision: handle.revision + 1,
        path: target_path.to_string(),
        page_count,
        pages,
        file_size,
    })
}

fn verify_save_target_unchanged(handle: &DocHandle, target_path: &str) -> Result<(), PdfError> {
    if !paths_refer_to_same_file(&handle.path, target_path) {
        return Ok(());
    }

    let disk_bytes = std::fs::read(target_path)
        .map_err(|_| PdfError::ExternalModification(target_path.to_string()))?;
    if sha256_hex(&disk_bytes) != handle.disk_fingerprint {
        return Err(PdfError::ExternalModification(target_path.to_string()));
    }
    Ok(())
}

/// Export a flattened copy without changing the open document. The mutation
/// lock and revision check ensure the output cannot mix annotations captured
/// for one generation with PDF bytes from another.
pub fn export_doc_with_annotations(
    registry: &DocRegistry,
    doc_id: &str,
    expected_revision: u64,
    target_path: &str,
    data: Value,
) -> Result<(), PdfError> {
    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
    if registry.path_is_open(target_path, None) {
        return Err(PdfError::OpenDocumentConflict(target_path.to_string()));
    }
    let bytes = flatten_pdf_bytes(handle.bytes.as_ref(), data)?;
    atomic_write(target_path, &bytes)?;
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
    expected_revision: u64,
    page_index: usize,
    x_pts: f32,
    y_pts: f32,
    w_pts: f32,
    h_pts: f32,
    scale: f32,
) -> Result<Vec<u8>, PdfError> {
    use pdfium_render::prelude::PdfRenderConfig;

    let handle = registry.get_at_revision(doc_id, expected_revision)?;
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
    if !page_w_pts.is_finite()
        || !page_h_pts.is_finite()
        || page_w_pts <= 0.0
        || page_h_pts <= 0.0
        || !x_pts.is_finite()
        || !y_pts.is_finite()
        || !w_pts.is_finite()
        || !h_pts.is_finite()
    {
        return Err(PdfError::Pdfium(
            "capture region or page dimensions are invalid".into(),
        ));
    }

    // Render the entire page at the requested scale, then crop.
    // Cropping a render is cheap relative to running pdfium, so we don't
    // bother with pdfium's own clip-rect setting (the API surface is
    // version-sensitive and renderConfig clipping doesn't shrink the
    // output buffer — it just ignores ink outside the rect).
    const PT_TO_PX: f32 = 96.0 / 72.0;
    let safe_scale = if scale.is_finite() && scale > 0.0 {
        scale.min(16.0)
    } else {
        2.0
    };
    let mut pixel_scale = safe_scale * PT_TO_PX;
    // Bound the full-page render so a pathological MediaBox can't trigger a
    // huge allocation. Crop coordinates below use the same `pixel_scale`, so
    // scaling it down keeps the crop rect aligned.
    const MAX_DIM: f32 = 10_000.0;
    let over = (page_w_pts * pixel_scale / MAX_DIM).max(page_h_pts * pixel_scale / MAX_DIM);
    if over > 1.0 {
        pixel_scale /= over;
    }
    const MAX_PIXELS: f32 = 32_000_000.0;
    let pixel_count = page_w_pts * page_h_pts * pixel_scale * pixel_scale;
    if pixel_count > MAX_PIXELS {
        pixel_scale *= (MAX_PIXELS / pixel_count).sqrt();
    }
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

    let cropped =
        image::imageops::crop_imm(&rgba_full, crop_x, crop_y, final_w, final_h).to_image();

    let mut out: Vec<u8> = Vec::with_capacity((final_w * final_h * 4) as usize);
    cropped
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| PdfError::Image(e.to_string()))?;
    let current = registry.get(doc_id)?;
    if !Arc::ptr_eq(&handle, &current) {
        return Err(PdfError::StaleDocument {
            expected: expected_revision,
            actual: current.revision,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::document::open_document;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine as _;
    use image::{DynamicImage, Rgba, RgbaImage};
    use pdfium_render::prelude::{PdfPagePaperSize, PdfRenderConfig};
    use serde_json::json;
    use std::io::Cursor;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rotate_pages_persists_intrinsic_rotation_in_registry_and_saved_pdf() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rustpdf-rotate-pages-{stamp}"));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let source_path = temp_dir.join("source.pdf");
        let target_path = temp_dir.join("rotated.pdf");

        {
            let pdfium = create_pdfium().unwrap();
            let mut document = pdfium.create_new_pdf().unwrap();
            document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::a4())
                .unwrap();
            std::fs::write(&source_path, document.save_to_bytes().unwrap()).unwrap();
        }

        let registry = DocRegistry::new();
        let cache = PageCache::new(1024 * 1024);
        let text = TextCache::new();
        let opened = open_document(&registry, source_path.to_string_lossy().to_string()).unwrap();
        let before = opened.pages[0].clone();

        let rotated = rotate_pages(
            &registry,
            &cache,
            &text,
            &opened.id,
            opened.revision,
            &[0],
            1,
        )
        .unwrap();
        assert_eq!(rotated.id, opened.id);
        assert_eq!(rotated.pages[0].rotation, 90);
        assert!((rotated.pages[0].width - before.height).abs() < 0.01);
        assert!((rotated.pages[0].height - before.width).abs() < 0.01);

        save_doc_as(
            &registry,
            &opened.id,
            rotated.revision,
            target_path.to_str().unwrap(),
        )
        .unwrap();
        let saved_bytes = std::fs::read(&target_path).unwrap();
        let pdfium = create_pdfium().unwrap();
        let saved = pdfium.load_pdf_from_byte_slice(&saved_bytes, None).unwrap();
        let saved_page = saved.pages().get(0).unwrap();
        assert_eq!(saved_page.rotation().unwrap().as_degrees(), 90.0);
        assert!((saved_page.width().value - before.height).abs() < 0.01);
        assert!((saved_page.height().value - before.width).abs() < 0.01);

        drop(saved_page);
        drop(saved);
        drop(pdfium);
        let _ = std::fs::remove_file(&source_path);
        let _ = std::fs::remove_file(&target_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn save_doc_with_annotations_updates_registry_bytes() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rustpdf-save-doc-{stamp}"));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let source_path = temp_dir.join("source.pdf");
        let target_path = temp_dir.join("saved.pdf");

        {
            let pdfium = create_pdfium().unwrap();
            let mut document = pdfium.create_new_pdf().unwrap();
            document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::a4())
                .unwrap();
            let source_bytes = document.save_to_bytes().unwrap();
            std::fs::write(&source_path, source_bytes).unwrap();
        }

        let registry = DocRegistry::new();
        let opened = open_document(&registry, source_path.to_string_lossy().to_string()).unwrap();

        let source = DynamicImage::ImageRgba8(RgbaImage::from_pixel(4, 4, Rgba([255, 0, 0, 255])));
        let mut bytes = Cursor::new(Vec::new());
        source
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let src = format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(bytes.into_inner())
        );
        let data = json!({
            "annotations": [{
                "page": 0,
                "type": "image",
                "rect": { "x": 72.0, "y": 72.0, "w": 72.0, "h": 72.0 },
                "style": { "opacity": 1.0 },
                "payload": { "imageSrc": src }
            }]
        });

        let saved = save_doc_with_annotations(
            &registry,
            &opened.id,
            opened.revision,
            target_path.to_str().unwrap(),
            Some(data),
            |_| Ok(()),
        )
        .unwrap();

        assert_eq!(saved.id, opened.id);
        assert_eq!(saved.path, target_path.to_string_lossy());

        let handle = registry.get(&opened.id).unwrap();
        assert_eq!(handle.path, target_path.to_string_lossy());

        let pdfium = create_pdfium().unwrap();
        let rendered = pdfium
            .load_pdf_from_byte_slice(handle.bytes.as_ref(), None)
            .unwrap()
            .pages()
            .get(0)
            .unwrap()
            .render_with_config(&PdfRenderConfig::new().set_target_width(595))
            .unwrap()
            .as_image()
            .into_rgba8();
        let stamped = rendered.get_pixel(100, 100).0;

        assert!(
            stamped[0] > 200 && stamped[1] < 40 && stamped[2] < 40,
            "expected saved image pixel to be red, got {stamped:?}"
        );

        let _ = std::fs::remove_file(&source_path);
        let _ = std::fs::remove_file(&target_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn save_refuses_to_overwrite_pdf_changed_by_another_process() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rustpdf-save-conflict-{stamp}"));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let source_path = temp_dir.join("source.pdf");

        {
            let pdfium = create_pdfium().unwrap();
            let mut document = pdfium.create_new_pdf().unwrap();
            document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::a4())
                .unwrap();
            std::fs::write(&source_path, document.save_to_bytes().unwrap()).unwrap();
        }

        let registry = DocRegistry::new();
        let opened = open_document(&registry, source_path.to_string_lossy().to_string()).unwrap();
        let original_handle = registry.get(&opened.id).unwrap();
        let external_bytes = b"contents written by another process";
        std::fs::write(&source_path, external_bytes).unwrap();

        let result = save_doc_with_annotations(
            &registry,
            &opened.id,
            opened.revision,
            source_path.to_str().unwrap(),
            None,
            |_| panic!("sidecar staging must not run after a known conflict"),
        );

        assert!(matches!(result, Err(PdfError::ExternalModification(_))));
        assert_eq!(std::fs::read(&source_path).unwrap(), external_bytes);
        let current = registry.get(&opened.id).unwrap();
        assert!(Arc::ptr_eq(&current, &original_handle));
        assert_eq!(current.revision, opened.revision);

        let _ = std::fs::remove_file(&source_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn save_rechecks_for_external_change_immediately_before_commit() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rustpdf-save-race-{stamp}"));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let source_path = temp_dir.join("source.pdf");

        {
            let pdfium = create_pdfium().unwrap();
            let mut document = pdfium.create_new_pdf().unwrap();
            document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::a4())
                .unwrap();
            std::fs::write(&source_path, document.save_to_bytes().unwrap()).unwrap();
        }

        let registry = DocRegistry::new();
        let opened = open_document(&registry, source_path.to_string_lossy().to_string()).unwrap();
        let external_bytes = b"late external replacement";
        let path_for_staging = source_path.clone();

        let result = save_doc_with_annotations(
            &registry,
            &opened.id,
            opened.revision,
            source_path.to_str().unwrap(),
            None,
            move |_| {
                std::fs::write(path_for_staging, external_bytes)?;
                Ok(())
            },
        );

        assert!(matches!(result, Err(PdfError::ExternalModification(_))));
        assert_eq!(std::fs::read(&source_path).unwrap(), external_bytes);
        assert_eq!(registry.get(&opened.id).unwrap().revision, opened.revision);

        let _ = std::fs::remove_file(&source_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }

    #[test]
    fn save_as_and_export_refuse_to_overwrite_any_open_pdf() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rustpdf-open-target-{stamp}"));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let source_path = temp_dir.join("source.pdf");
        let other_path = temp_dir.join("other.pdf");

        for path in [&source_path, &other_path] {
            let pdfium = create_pdfium().unwrap();
            let mut document = pdfium.create_new_pdf().unwrap();
            document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::a4())
                .unwrap();
            std::fs::write(path, document.save_to_bytes().unwrap()).unwrap();
        }
        let other_bytes = std::fs::read(&other_path).unwrap();

        let registry = DocRegistry::new();
        let source = open_document(&registry, source_path.to_string_lossy().to_string()).unwrap();
        let other = open_document(&registry, other_path.to_string_lossy().to_string()).unwrap();

        let save_result = save_doc_with_annotations(
            &registry,
            &source.id,
            source.revision,
            other_path.to_str().unwrap(),
            None,
            |_| Ok(()),
        );
        assert!(matches!(
            save_result,
            Err(PdfError::OpenDocumentConflict(_))
        ));
        assert_eq!(std::fs::read(&other_path).unwrap(), other_bytes);
        assert_eq!(registry.get(&source.id).unwrap().revision, source.revision);
        assert_eq!(registry.get(&other.id).unwrap().revision, other.revision);

        let export_result = export_doc_with_annotations(
            &registry,
            &source.id,
            source.revision,
            source_path.to_str().unwrap(),
            json!({ "annotations": [] }),
        );
        assert!(matches!(
            export_result,
            Err(PdfError::OpenDocumentConflict(_))
        ));

        let _ = std::fs::remove_file(&source_path);
        let _ = std::fs::remove_file(&other_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }
}
