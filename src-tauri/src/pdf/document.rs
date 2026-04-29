use super::{create_pdfium, PdfError};
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub index: usize,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub id: String,
    pub path: String,
    pub page_count: usize,
    pub pages: Vec<PageMeta>,
    pub file_size: u64,
}

/// Owned document state. We keep the file bytes in memory and re-instantiate
/// pdfium per render call (pdfium-render's bindings aren't Send across threads
/// without the mutex wrapper, so we keep this code path simple).
pub struct DocHandle {
    pub path: String,
    pub bytes: Arc<Vec<u8>>,
    pub page_count: usize,
    pub pages: Vec<PageMeta>,
}

pub struct DocRegistry {
    inner: RwLock<HashMap<String, Arc<DocHandle>>>,
}

impl DocRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<DocHandle>, PdfError> {
        self.inner
            .read()
            .get(id)
            .cloned()
            .ok_or(PdfError::InvalidHandle)
    }

    pub fn insert(&self, handle: DocHandle) -> String {
        let id = Uuid::new_v4().to_string();
        self.inner.write().insert(id.clone(), Arc::new(handle));
        id
    }

    pub fn remove(&self, id: &str) -> bool {
        self.inner.write().remove(id).is_some()
    }

    pub fn replace(&self, id: &str, handle: DocHandle) -> Result<(), PdfError> {
        let mut map = self.inner.write();
        if !map.contains_key(id) {
            return Err(PdfError::InvalidHandle);
        }
        map.insert(id.to_string(), Arc::new(handle));
        Ok(())
    }
}

pub fn open_document(registry: &DocRegistry, path: String) -> Result<OpenedDocument, PdfError> {
    let bytes = std::fs::read(&path)?;
    let file_size = bytes.len() as u64;
    let bytes = Arc::new(bytes);

    let pdfium = create_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let pages_iter = doc.pages();
    let page_count = pages_iter.len() as usize;
    let mut pages = Vec::with_capacity(page_count);
    for (i, page) in pages_iter.iter().enumerate() {
        pages.push(PageMeta {
            index: i,
            width: page.width().value,
            height: page.height().value,
        });
    }

    let handle = DocHandle {
        path: path.clone(),
        bytes: Arc::clone(&bytes),
        page_count,
        pages: pages.clone(),
    };
    let id = registry.insert(handle);

    Ok(OpenedDocument {
        id,
        path,
        page_count,
        pages,
        file_size,
    })
}

pub fn close_document(registry: &DocRegistry, doc_id: &str) -> bool {
    registry.remove(doc_id)
}
