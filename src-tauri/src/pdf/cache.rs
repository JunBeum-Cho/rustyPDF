use lru::LruCache;
use parking_lot::Mutex;
use std::sync::Arc;

#[derive(Clone, Hash, Eq, PartialEq, Debug)]
pub struct CacheKey {
    pub doc_id: String,
    pub revision: u64,
    pub page_index: usize,
    pub scale_bucket: u32, // scale * 100, rounded
    pub rotation: u16,     // 0/90/180/270
}

struct CacheEntry {
    bytes: Arc<Vec<u8>>,
    size: usize,
}

/// LRU cache of rendered page RGBA responses bounded purely by a byte budget.
/// When inserting an entry would exceed `max_bytes`, oldest entries are evicted
/// until the budget is satisfied (or the cache is empty). The underlying
/// `LruCache` is unbounded by count — a count cap would let it silently evict
/// entries without decrementing `used_bytes`, drifting the budget over time.
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
                map: LruCache::unbounded(),
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
        // An individual high-zoom page can be larger than the whole cache
        // budget. It may still be returned to the caller, but retaining it
        // here would violate the byte bound and double the memory spike.
        if size > self.max_bytes {
            return;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn key(page_index: usize) -> CacheKey {
        CacheKey {
            doc_id: "doc".into(),
            revision: 0,
            page_index,
            scale_bucket: 100,
            rotation: 0,
        }
    }

    #[test]
    fn oversized_entry_is_not_retained_past_budget() {
        let cache = PageCache::new(4);
        cache.put(key(0), Arc::new(vec![1, 2, 3, 4]), 4);
        cache.put(key(1), Arc::new(vec![0; 5]), 5);

        assert!(cache.get(&key(0)).is_some());
        assert!(cache.get(&key(1)).is_none());
    }
}
