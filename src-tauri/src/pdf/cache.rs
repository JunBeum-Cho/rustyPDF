use lru::LruCache;
use parking_lot::Mutex;
use std::num::NonZeroUsize;
use std::sync::Arc;

#[derive(Clone, Hash, Eq, PartialEq, Debug)]
pub struct CacheKey {
    pub doc_id: String,
    pub page_index: usize,
    pub scale_bucket: u32, // scale * 100, rounded
    pub rotation: u16,     // 0/90/180/270
}

struct CacheEntry {
    bytes: Arc<Vec<u8>>,
    size: usize,
}

/// LRU cache of rendered page PNG bytes with a soft byte budget.
/// When inserting an entry would exceed `max_bytes`, oldest entries are evicted
/// until the budget is satisfied (or the cache is empty).
pub struct PageCache {
    inner: Mutex<Inner>,
    max_bytes: usize,
}

struct Inner {
    map: LruCache<CacheKey, CacheEntry>,
    used_bytes: usize,
}

impl PageCache {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                map: LruCache::new(NonZeroUsize::new(1024).expect("nonzero")),
                used_bytes: 0,
            }),
            max_bytes,
        }
    }

    pub fn get(&self, key: &CacheKey) -> Option<Arc<Vec<u8>>> {
        let mut inner = self.inner.lock();
        inner.map.get(key).map(|e| Arc::clone(&e.bytes))
    }

    pub fn put(&self, key: CacheKey, bytes: Arc<Vec<u8>>, size: usize) {
        let mut inner = self.inner.lock();

        // Replace any existing entry for this key first.
        if let Some(old) = inner.map.pop(&key) {
            inner.used_bytes = inner.used_bytes.saturating_sub(old.size);
        }

        // Evict until we have room.
        while inner.used_bytes + size > self.max_bytes && !inner.map.is_empty() {
            if let Some((_, evicted)) = inner.map.pop_lru() {
                inner.used_bytes = inner.used_bytes.saturating_sub(evicted.size);
            } else {
                break;
            }
        }

        inner.used_bytes += size;
        inner.map.put(key, CacheEntry { bytes, size });
    }

    pub fn purge_doc(&self, doc_id: &str) {
        let mut inner = self.inner.lock();
        let keys: Vec<CacheKey> = inner
            .map
            .iter()
            .filter(|(k, _)| k.doc_id == doc_id)
            .map(|(k, _)| k.clone())
            .collect();
        for k in keys {
            if let Some(e) = inner.map.pop(&k) {
                inner.used_bytes = inner.used_bytes.saturating_sub(e.size);
            }
        }
    }
}
