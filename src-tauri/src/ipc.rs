use crate::pdf::cache::PageCache;
use crate::pdf::document::DocRegistry;
use crate::pdf::edit::PageClipboard;
use crate::pdf::ocr::OcrCache;
use crate::pdf::text::TextCache;
use parking_lot::Mutex;
use std::sync::OnceLock;

pub struct AppState {
    pub registry: DocRegistry,
    pub cache: PageCache,
    pub text: TextCache,
    pub clipboard: PageClipboard,
    pub ocr: OcrCache,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            registry: DocRegistry::new(),
            cache: PageCache::new(256 * 1024 * 1024),
            text: TextCache::new(),
            clipboard: PageClipboard::new(),
            ocr: OcrCache::new(),
        }
    }
}

/// Path queue for "open before the webview is ready" events. macOS in
/// particular delivers `Opened` urls through `RunEvent` before our JS-side
/// listener has wired up. We stash them here and drain on first call to
/// `initial_open_paths`. Same queue also handles second-instance forwards
/// from `tauri-plugin-single-instance`.
static PENDING_OPEN_PATHS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn pending_lock() -> &'static Mutex<Vec<String>> {
    PENDING_OPEN_PATHS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn queue_open_paths<I: IntoIterator<Item = String>>(paths: I) {
    let mut q = pending_lock().lock();
    for p in paths {
        if !q.contains(&p) {
            q.push(p);
        }
    }
}

pub fn take_pending_open_paths() -> Vec<String> {
    let mut q = pending_lock().lock();
    std::mem::take(&mut *q)
}
