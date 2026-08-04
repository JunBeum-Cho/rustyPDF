use super::document::DocRegistry;
use super::ocr::{OcrCache, OcrLine};
use super::{create_pdfium, PdfError};
use parking_lot::RwLock;
use pdfium_render::prelude::PdfPageRenderRotation;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// Per-document, per-page extracted text. We extract lazily — first call to
/// `search` against a doc warms the entire cache, subsequent searches hit RAM.
pub struct TextCache {
    inner: RwLock<HashMap<String, TextCacheEntry>>,
}

struct TextCacheEntry {
    revision: u64,
    pages: Arc<Vec<String>>,
}

impl TextCache {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    pub fn invalidate(&self, doc_id: &str) {
        self.inner.write().remove(doc_id);
    }

    fn get(&self, doc_id: &str, revision: u64) -> Option<Arc<Vec<String>>> {
        self.inner
            .read()
            .get(doc_id)
            .filter(|entry| entry.revision == revision)
            .map(|entry| Arc::clone(&entry.pages))
    }

    fn put(&self, doc_id: &str, revision: u64, pages: Vec<String>) {
        self.inner.write().insert(
            doc_id.to_string(),
            TextCacheEntry {
                revision,
                pages: Arc::new(pages),
            },
        );
    }
}

fn extract_all_pages(bytes: &[u8]) -> Result<Vec<String>, PdfError> {
    let pdfium = create_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let pages_iter = doc.pages();
    let len = pages_iter.len() as usize;
    let mut out = Vec::with_capacity(len);
    for page in pages_iter.iter() {
        let text = page.text().map(|t| t.all()).unwrap_or_default();
        out.push(text);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub page: usize,
    pub start: usize,
    pub length: usize,
    pub snippet: String,
}

const SNIPPET_RADIUS: usize = 40;

/// Largest char-boundary offset `<= i` (clamped to `s.len()`). Used to map a
/// byte offset computed against `text.to_lowercase()` back onto the original
/// `text`: case folding can change byte length (e.g. `İ`→`i̇`, `ẞ`→`ß`), so a
/// lowercase offset may land mid-char in the original. Slicing there would
/// panic — and with `panic = "abort"` that takes the whole app down.
fn floor_char_boundary(s: &str, i: usize) -> usize {
    let mut i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn make_snippet(text: &str, byte_start: usize, byte_end: usize) -> String {
    // Walk char boundaries so we don't slice mid-grapheme.
    let pre_start = text[..byte_start]
        .char_indices()
        .rev()
        .nth(SNIPPET_RADIUS)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let post_end = text[byte_end..]
        .char_indices()
        .nth(SNIPPET_RADIUS)
        .map(|(i, _)| byte_end + i)
        .unwrap_or(text.len());

    let mut s = String::new();
    if pre_start > 0 {
        s.push('…');
    }
    s.push_str(&text[pre_start..post_end].replace('\n', " "));
    if post_end < text.len() {
        s.push('…');
    }
    s
}

/// Extract a per-page text layer directly from the PDF (no OCR). Works for
/// any PDF that actually carries embedded text — PDFs exported from Word /
/// Excel / Pages / browsers all do, even when they look like an image at
/// the page level. Returns lines normalized to 0–1 with top-left origin so
/// the frontend can render the same `TextLayer` it uses for OCR.
///
/// Returns `Ok(empty)` for fully-scanned pages (no embedded text) — the
/// caller should treat empty as "no native text, try OCR instead".
pub fn extract_native_text_lines(
    registry: &DocRegistry,
    doc_id: &str,
    expected_revision: u64,
    page_index: usize,
) -> Result<Vec<OcrLine>, PdfError> {
    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
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
    let display_w = page.width().value;
    let display_h = page.height().value;
    let rotation = page
        .rotation()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;
    // Pdfium exposes width/height after intrinsic `/Rotate`, while text
    // segment bounds remain in the page's raw PDF coordinate system. Native
    // text lines are intentionally normalized in that raw space; the
    // frontend rotates the whole selectable layer with the page so glyph
    // orientation and bounding boxes stay aligned.
    let (page_w, page_h) = if matches!(
        rotation,
        PdfPageRenderRotation::Degrees90 | PdfPageRenderRotation::Degrees270
    ) {
        (display_h, display_w)
    } else {
        (display_w, display_h)
    };
    if page_w <= 0.0 || page_h <= 0.0 {
        return Ok(Vec::new());
    }

    let text = match page.text() {
        Ok(t) => t,
        Err(_) => return Ok(Vec::new()),
    };

    // pdfium gives us "segments" — runs of text with a single bounding rect.
    // For Excel/Word exports each cell or text run lives in its own segment,
    // which is the level of granularity we want for selection: a row of a
    // table won't bleed into the next row when the user drags across it.
    // PdfRect uses bottom-left origin and PDF-point units; we flip Y and
    // normalize to 0..1 so the same `TextLayer` consumer works for OCR
    // results (which are already top-left normalized).
    let mut out: Vec<OcrLine> = Vec::new();
    for segment in text.segments().iter() {
        let bounds = segment.bounds();
        let segment_text = segment.text();
        if segment_text.is_empty() {
            continue;
        }
        let left = bounds.left().value;
        let right = bounds.right().value;
        let top = bounds.top().value;
        let bottom = bounds.bottom().value;
        let x = (left / page_w).clamp(0.0, 1.0);
        let w = ((right - left) / page_w).clamp(0.0, 1.0);
        // PDF Y-axis is bottom-up, screen is top-down → flip and use top
        // edge as the upper boundary in screen coords.
        let y = (1.0 - top / page_h).clamp(0.0, 1.0);
        let h = ((top - bottom) / page_h).clamp(0.0, 1.0);
        if w <= 0.0 || h <= 0.0 {
            continue;
        }
        out.push(OcrLine {
            text: segment_text,
            x,
            y,
            w,
            h,
        });
    }
    Ok(out)
}

pub fn search(
    cache: &TextCache,
    registry: &DocRegistry,
    ocr: &OcrCache,
    doc_id: &str,
    expected_revision: u64,
    query: &str,
) -> Result<Vec<SearchHit>, PdfError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    // Structural edits invalidate both native and OCR page-indexed text. Hold
    // the same document lock they use until this cache read/extract/insert is
    // complete, preventing a stale extraction from landing after invalidation.
    let mutation_lock = registry.mutation_lock(doc_id)?;
    let _mutation_guard = mutation_lock.lock();
    let handle = registry.get_at_revision(doc_id, expected_revision)?;
    let pages = match cache.get(doc_id, handle.revision) {
        Some(p) => p,
        None => {
            let mut pages = extract_all_pages(&handle.bytes)?;
            // For pages where pdfium found no embedded text (typical of
            // scanned PDFs), substitute the OCR cache so search hits cover
            // OCR'd content. Pages that have neither stay empty — search
            // simply won't match them.
            for (i, text) in pages.iter_mut().enumerate() {
                if text.trim().is_empty() {
                    if let Some(ocr_text) = ocr.get_text(doc_id, i, handle.revision) {
                        *text = ocr_text;
                    }
                }
            }
            cache.put(doc_id, handle.revision, pages);
            cache.get(doc_id, handle.revision).expect("just inserted")
        }
    };

    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    for (page_index, text) in pages.iter().enumerate() {
        let haystack = text.to_lowercase();
        let mut search_from = 0;
        while let Some(rel) = haystack[search_from..].find(&needle) {
            let abs = search_from + rel;
            let end = abs + needle.len();
            // The lowercase haystack has the same byte boundaries as the
            // original for ASCII. For non-ASCII, case folding can shift byte
            // offsets, so snap both ends to char boundaries of the *original*
            // text before slicing — approximate highlight, but never panics.
            let snippet_start = floor_char_boundary(text, abs);
            let snippet_end = floor_char_boundary(text, end).max(snippet_start);
            hits.push(SearchHit {
                page: page_index,
                start: snippet_start,
                length: snippet_end.saturating_sub(snippet_start),
                snippet: make_snippet(text, snippet_start, snippet_end),
            });
            search_from = end;
            if hits.len() >= 1000 {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::document::DocHandle;
    use pdfium_render::prelude::{PdfPageObjectsCommon, PdfPagePaperSize, PdfPoints};

    fn extract_test_line(rotation: PdfPageRenderRotation) -> OcrLine {
        let bytes = {
            let pdfium = create_pdfium().unwrap();
            let mut document = pdfium.create_new_pdf().unwrap();
            let font = document.fonts_mut().helvetica();
            let mut page = document
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::a4())
                .unwrap();
            page.objects_mut()
                .create_text_object(
                    PdfPoints::new(100.0),
                    PdfPoints::new(200.0),
                    "ROTATION TEST",
                    font,
                    PdfPoints::new(24.0),
                )
                .unwrap();
            page.set_rotation(rotation);
            drop(page);
            document.save_to_bytes().unwrap()
        };

        let registry = DocRegistry::new();
        let disk_fingerprint = crate::storage::sha256_hex(&bytes);
        let doc_id = registry.insert(DocHandle {
            path: String::new(),
            bytes: Arc::new(bytes),
            page_count: 1,
            pages: Vec::new(),
            disk_fingerprint,
            revision: 0,
        });
        extract_native_text_lines(&registry, &doc_id, 0, 0)
            .unwrap()
            .into_iter()
            .find(|line| line.text.contains("ROTATION TEST"))
            .expect("test text should be extractable")
    }

    #[test]
    fn native_text_bounds_stay_in_raw_space_for_intrinsic_rotation() {
        let expected = extract_test_line(PdfPageRenderRotation::None);
        for rotation in [
            PdfPageRenderRotation::Degrees90,
            PdfPageRenderRotation::Degrees180,
            PdfPageRenderRotation::Degrees270,
        ] {
            let actual = extract_test_line(rotation);
            assert_eq!(actual.text, expected.text);
            assert!((actual.x - expected.x).abs() < 0.001, "{rotation:?}");
            assert!((actual.y - expected.y).abs() < 0.001, "{rotation:?}");
            assert!((actual.w - expected.w).abs() < 0.001, "{rotation:?}");
            assert!((actual.h - expected.h).abs() < 0.001, "{rotation:?}");
        }
    }
}
