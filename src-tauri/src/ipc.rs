use crate::pdf::cache::PageCache;
use crate::pdf::document::DocRegistry;
use crate::pdf::text::TextCache;

pub struct AppState {
    pub registry: DocRegistry,
    pub cache: PageCache,
    pub text: TextCache,
}

impl AppState {
    pub fn new() -> Self {
        // 256 MB default budget for rendered page bitmaps.
        Self {
            registry: DocRegistry::new(),
            cache: PageCache::new(256 * 1024 * 1024),
            text: TextCache::new(),
        }
    }
}
