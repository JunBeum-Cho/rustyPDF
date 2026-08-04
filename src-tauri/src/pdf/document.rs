use super::{create_pdfium, PdfError};
use crate::storage::sha256_hex;
use parking_lot::{Mutex, RwLock};
use pdfium_render::prelude::{PdfDocument, PdfPage};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub index: usize,
    pub width: f32,
    pub height: f32,
    /// Intrinsic clockwise page rotation stored in the PDF (`/Rotate`).
    /// `width` and `height` are the dimensions after this rotation is applied.
    pub rotation: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub id: String,
    pub revision: u64,
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
    /// Fingerprint of the bytes last read from or committed to `path`.
    /// Page edits replace `bytes` in memory but preserve this baseline so a
    /// later save cannot silently overwrite changes made by another process.
    pub disk_fingerprint: String,
    /// Monotonically increasing generation for this open document. Every
    /// page mutation and save replaces the handle with `revision + 1`.
    pub revision: u64,
}

pub struct DocRegistry {
    inner: RwLock<HashMap<String, Arc<DocHandle>>>,
    mutation_locks: RwLock<HashMap<String, Arc<Mutex<()>>>>,
}

pub(crate) fn paths_refer_to_same_file(left: &str, right: &str) -> bool {
    if Path::new(left) == Path::new(right) {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

pub(crate) fn page_meta(index: usize, page: &PdfPage<'_>) -> Result<PageMeta, PdfError> {
    let rotation = page
        .rotation()
        .map_err(|e| PdfError::Pdfium(e.to_string()))?
        .as_degrees() as u16;
    Ok(PageMeta {
        index,
        width: page.width().value,
        height: page.height().value,
        rotation,
    })
}

pub(crate) fn collect_page_meta(doc: &PdfDocument<'_>) -> Result<Vec<PageMeta>, PdfError> {
    doc.pages()
        .iter()
        .enumerate()
        .map(|(index, page)| page_meta(index, &page))
        .collect()
}

impl DocRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            mutation_locks: RwLock::new(HashMap::new()),
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
        self.mutation_locks
            .write()
            .insert(id.clone(), Arc::new(Mutex::new(())));
        id
    }

    /// Whether `path` belongs to any currently open document other than the
    /// optional excluded handle. Used to keep Save As / Export from silently
    /// changing the backing file underneath another tab.
    pub fn path_is_open(&self, path: &str, except_doc_id: Option<&str>) -> bool {
        self.inner.read().iter().any(|(id, handle)| {
            except_doc_id != Some(id.as_str()) && paths_refer_to_same_file(&handle.path, path)
        })
    }

    pub fn remove(&self, id: &str) -> bool {
        // Closing waits for an in-flight mutation rather than invalidating
        // its handle halfway through publication.
        let lock = self.mutation_locks.read().get(id).cloned();
        let Some(lock) = lock else {
            return false;
        };
        let _guard = lock.lock();
        let removed = self.inner.write().remove(id).is_some();
        self.mutation_locks.write().remove(id);
        removed
    }

    /// Return the stable per-document serialization lock. Callers must hold
    /// this for the complete read/transform/publish mutation transaction.
    pub fn mutation_lock(&self, id: &str) -> Result<Arc<Mutex<()>>, PdfError> {
        self.mutation_locks
            .read()
            .get(id)
            .cloned()
            .ok_or(PdfError::InvalidHandle)
    }

    pub fn get_at_revision(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<Arc<DocHandle>, PdfError> {
        let handle = self.get(id)?;
        if handle.revision != expected_revision {
            return Err(PdfError::StaleDocument {
                expected: expected_revision,
                actual: handle.revision,
            });
        }
        Ok(handle)
    }

    /// Publish only if the registry still contains the exact handle from
    /// which the new bytes were derived. The pointer comparison is a final
    /// backend CAS guard even when a caller supplies a bad revision.
    pub fn replace_if_current(
        &self,
        id: &str,
        current: &Arc<DocHandle>,
        handle: DocHandle,
    ) -> Result<(), PdfError> {
        let mut map = self.inner.write();
        let existing = map.get(id).ok_or(PdfError::InvalidHandle)?;
        if !Arc::ptr_eq(existing, current) {
            return Err(PdfError::StaleDocument {
                expected: current.revision,
                actual: existing.revision,
            });
        }
        map.insert(id.to_string(), Arc::new(handle));
        Ok(())
    }
}

pub fn open_document(registry: &DocRegistry, path: String) -> Result<OpenedDocument, PdfError> {
    let bytes = std::fs::read(&path)?;
    let file_size = bytes.len() as u64;
    let disk_fingerprint = sha256_hex(&bytes);
    let bytes = Arc::new(bytes);

    let pdfium = create_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| PdfError::Pdfium(e.to_string()))?;

    let page_count = doc.pages().len() as usize;
    let pages = collect_page_meta(&doc)?;

    let handle = DocHandle {
        path: path.clone(),
        bytes: Arc::clone(&bytes),
        page_count,
        pages: pages.clone(),
        disk_fingerprint,
        revision: 0,
    };
    let id = registry.insert(handle);

    Ok(OpenedDocument {
        id,
        revision: 0,
        path,
        page_count,
        pages,
        file_size,
    })
}

pub fn close_document(registry: &DocRegistry, doc_id: &str) -> bool {
    registry.remove(doc_id)
}

#[cfg(test)]
mod tests {
    use super::{create_pdfium, page_meta, DocHandle, DocRegistry};
    use crate::pdf::PdfError;
    use pdfium_render::prelude::{PdfPagePaperSize, PdfPageRenderRotation};
    use std::sync::Arc;

    #[test]
    fn page_meta_reports_intrinsic_rotation_and_display_dimensions() {
        let pdfium = create_pdfium().unwrap();
        let mut document = pdfium.create_new_pdf().unwrap();
        let mut page = document
            .pages_mut()
            .create_page_at_end(PdfPagePaperSize::a4())
            .unwrap();
        let before = (page.width().value, page.height().value);
        page.set_rotation(PdfPageRenderRotation::Degrees90);
        let meta = page_meta(0, &page).unwrap();

        assert_eq!(meta.rotation, 90);
        assert!((meta.width - before.1).abs() < 0.01);
        assert!((meta.height - before.0).abs() < 0.01);
    }

    #[test]
    fn registry_rejects_stale_revision_and_stale_handle_publication() {
        let registry = DocRegistry::new();
        let id = registry.insert(DocHandle {
            path: "revision.pdf".into(),
            bytes: Arc::new(vec![1]),
            page_count: 0,
            pages: Vec::new(),
            disk_fingerprint: "01".into(),
            revision: 0,
        });
        let original = registry.get_at_revision(&id, 0).unwrap();
        registry
            .replace_if_current(
                &id,
                &original,
                DocHandle {
                    path: "revision.pdf".into(),
                    bytes: Arc::new(vec![2]),
                    page_count: 0,
                    pages: Vec::new(),
                    disk_fingerprint: "01".into(),
                    revision: 1,
                },
            )
            .unwrap();

        assert!(matches!(
            registry.get_at_revision(&id, 0),
            Err(PdfError::StaleDocument {
                expected: 0,
                actual: 1
            })
        ));
        assert!(matches!(
            registry.replace_if_current(
                &id,
                &original,
                DocHandle {
                    path: "revision.pdf".into(),
                    bytes: Arc::new(vec![3]),
                    page_count: 0,
                    pages: Vec::new(),
                    disk_fingerprint: "01".into(),
                    revision: 1,
                }
            ),
            Err(PdfError::StaleDocument { actual: 1, .. })
        ));
    }
}
