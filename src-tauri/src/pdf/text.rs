use super::document::DocRegistry;
use super::{create_pdfium, PdfError};
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// Per-document, per-page extracted text. We extract lazily — first call to
/// `search` against a doc warms the entire cache, subsequent searches hit RAM.
pub struct TextCache {
    inner: RwLock<HashMap<String, Arc<Vec<String>>>>,
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

    fn get(&self, doc_id: &str) -> Option<Arc<Vec<String>>> {
        self.inner.read().get(doc_id).cloned()
    }

    fn put(&self, doc_id: &str, pages: Vec<String>) {
        self.inner
            .write()
            .insert(doc_id.to_string(), Arc::new(pages));
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

pub fn search(
    cache: &TextCache,
    registry: &DocRegistry,
    doc_id: &str,
    query: &str,
) -> Result<Vec<SearchHit>, PdfError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let pages = match cache.get(doc_id) {
        Some(p) => p,
        None => {
            let handle = registry.get(doc_id)?;
            let pages = extract_all_pages(&handle.bytes)?;
            cache.put(doc_id, pages);
            cache.get(doc_id).expect("just inserted")
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
            // original because to_lowercase() preserves ASCII byte indices for
            // ASCII queries. For non-ASCII we approximate — good enough for
            // navigation; precise highlight is a separate concern.
            let snippet_end = end.min(text.len());
            let snippet_start = abs.min(text.len());
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
