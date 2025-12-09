# Duplicate Thumbnail Highlighter — Implementation Plan

> Unified plan synthesized from recommendations-3.md, RECOMMENDATIONS.md, and recommendations2.md

---

## Current State Assessment

### ✅ Working Well

| Feature | Location | Notes |
|---------|----------|-------|
| CORS bypass via background fetch | `background.js` | Solves tainted canvas problem |
| dHash computation | `hash.js` | 32×32 canvas, binary→hex |
| Sequential queue with 200ms throttle | `hash.js` | Conservative but stable |
| MutationObserver for SPA content | `content.js` | 1s debounce |
| Visual indicators | `content.js` | Stripes, badge, outline, HSL color scale |
| IndexedDB schema | `db.js` | Exists but unused |

### ❌ Critical Gaps

| Gap | Impact | All Docs Agree? |
|-----|--------|-----------------|
| **Exact hash match only** | Misses near-duplicates (JPEG recompression, slight resize) | ✅ Yes |
| **No visibility gating** | Hashes ALL images, including off-screen | ✅ Yes |
| **No error tracking** | Silent failures, potential retry loops | ✅ Yes |
| **No user controls** | Can't toggle or adjust sensitivity | ✅ Yes |

---

## Prioritized Implementation Phases

### Phase 1: Core Logic Fix (Ship-Blocking)

**Goal:** Stop missing near-duplicates

| Task | Effort | Impact |
|------|--------|--------|
| 1.1 Add `hammingDistance()` function | 30 min | Critical |
| 1.2 Add `findMatchingHash()` lookup | 30 min | Critical |
| 1.3 Wire into duplicate detection loop | 20 min | Critical |

#### Implementation Details

**Add to `hash.js`:**

```javascript
/**
 * Calculate Hamming distance between two hex hash strings.
 * Returns the number of differing bits.
 */
function hammingDistance(h1, h2) {
    if (h1.length !== h2.length) return Infinity;
    let distance = 0;
    for (let i = 0; i < h1.length; i++) {
        let xor = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
        while (xor) {
            distance += xor & 1;
            xor >>= 1;
        }
    }
    return distance;
}

// Expose on window.ThumbHash
window.ThumbHash = {
    queueHash,
    hammingDistance  // NEW
};
```

**Modify `content.js`:**

```javascript
const HAMMING_THRESHOLD = 5; // Configurable: 0 = exact match, 5 = lenient

/**
 * Find an existing hash that matches (exact or near-duplicate).
 * Returns the matching hash key, or null if no match.
 */
function findMatchingHash(newHash, hashToSrcUrls) {
    // Exact match first (fast path)
    if (hashToSrcUrls.has(newHash)) return newHash;
    
    // Near-duplicate search
    for (const existingHash of hashToSrcUrls.keys()) {
        if (window.ThumbHash.hammingDistance(newHash, existingHash) <= HAMMING_THRESHOLD) {
            return existingHash;
        }
    }
    return null;
}

// In processPage(), replace:
//   if (!hashToSrcUrls.has(realHash)) { ... }
// With:
//   const matchKey = findMatchingHash(realHash, hashToSrcUrls);
//   if (!matchKey) { hashToSrcUrls.set(realHash, new Set()); }
//   const targetKey = matchKey || realHash;
//   hashToSrcUrls.get(targetKey).add(src);
```

---

### Phase 2: Performance Optimization

**Goal:** Only hash what's visible, increase throughput

| Task | Effort | Impact |
|------|--------|--------|
| 2.1 Add IntersectionObserver | 45 min | High |
| 2.2 Increase concurrency to 3 | 15 min | Medium |
| 2.3 Add image size cap (skip >2MB) | 15 min | Medium |

#### Implementation Details

**IntersectionObserver in `content.js`:**

```javascript
const visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (entry.isIntersecting) {
            const img = entry.target;
            if (!processedSrcUrls.has(img.src)) {
                queueImageForHashing(img);
            }
            visibilityObserver.unobserve(img);
        }
    }
}, { rootMargin: '200px' }); // Start hashing 200px before visible

// In MutationObserver: observe new images instead of processing immediately
function observeNewImages() {
    document.querySelectorAll('img').forEach(img => {
        if (isValidImage(img) && !processedSrcUrls.has(img.src)) {
            visibilityObserver.observe(img);
        }
    });
}
```

**Concurrency in `hash.js`:**

```javascript
const MAX_CONCURRENT = 3;
let activeCount = 0;

function processQueue() {
    while (activeCount < MAX_CONCURRENT && queue.length > 0) {
        activeCount++;
        const task = queue.shift();
        
        computeHashInternal(task.url)
            .then(hash => task.resolve(hash))
            .catch(err => {
                console.warn("Hash failed:", err);
                task.resolve(null);
            })
            .finally(() => {
                activeCount--;
                processQueue(); // Process next immediately
            });
    }
}
```

**Size cap in `background.js`:**

```javascript
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB

fetch(url, { method: 'HEAD' })
    .then(response => {
        const size = parseInt(response.headers.get('content-length') || '0');
        if (size > MAX_IMAGE_SIZE) {
            throw new Error(`Image too large: ${size} bytes`);
        }
        return fetch(url);
    })
    // ... rest of pipeline
```

---

### Phase 3: Robustness

**Goal:** Handle edge cases gracefully

| Task | Effort | Impact |
|------|--------|--------|
| 3.1 Track unhashable URLs | 10 min | Medium |
| 3.2 Skip solid-color placeholders | 10 min | Low |
| 3.3 Use `currentSrc` for responsive images | 5 min | Low |
| 3.4 Add tooltips for accessibility | 10 min | Medium |

#### Implementation Details

**Unhashable tracking:**

```javascript
const unhashableUrls = new Set();

// In hash callback:
if (!realHash) {
    unhashableUrls.add(src);
    console.warn(`[Unhashable] ${src.substring(0, 60)}...`);
    return;
}
```

**Solid-color detection:**

```javascript
function isSolidColor(hash) {
    return hash === '0'.repeat(hash.length) || 
           hash === 'f'.repeat(hash.length);
}

// Skip if solid:
if (isSolidColor(realHash)) return;
```

**Responsive image support:**

```javascript
const src = img.currentSrc || img.src;
```

**Accessibility:**

```javascript
badge.setAttribute('title', `Duplicate: ${count} copies found on this page`);
badge.setAttribute('aria-label', `${count} duplicate copies`);
```

---

### Phase 4: User Experience (Post-MVP)

**Goal:** Give users control

| Task | Effort | Impact |
|------|--------|--------|
| 4.1 Extension popup UI | 2 hrs | High |
| 4.2 Toggle visibility on/off | 30 min | Medium |
| 4.3 Sensitivity slider (Hamming threshold) | 30 min | Medium |
| 4.4 "Scanning..." indicator | 20 min | Low |

**Popup controls needed:**

1. **Toggle:** Enable/disable highlighting
2. **Sensitivity slider:** Hamming threshold 0–10
3. **Stats display:** "Found X duplicate groups (Y images)"
4. **Reset button:** Clear current session data

---

### Phase 5: Persistence (Defer to V1.0)

**Goal:** Remember hashes across sessions

| Task | Effort | Impact |
|------|--------|--------|
| 5.1 Wire IndexedDB caching | 1 hr | Medium |
| 5.2 Add TTL/LRU eviction (24h, 5k cap) | 45 min | Medium |
| 5.3 Origin scoping | 30 min | Medium |

**Recommendation:** Stay **in-memory for MVP**. The current session-based detection is simpler, faster, and avoids stale data issues. Wire IndexedDB later for cross-session history.

---

## Locked Decisions

| Decision | Value | Rationale |
|----------|-------|-----------|
| Hamming threshold | **5 bits** | Catches JPEG artifacts, slight resizes; not too lenient |
| Minimum image size | **100×50** (current) | Works well, add solid-color skip instead of raising |
| Concurrency | **3 simultaneous** | Balances speed vs. resource usage |
| Debounce | **1 second** (current) | Reduces churn on fast scroll |
| Persistence | **In-memory for MVP** | Simpler, no stale data issues |
| host_permissions | Tighten to target site | Avoid `<all_urls>` in production |

---

## Version Roadmap

```
┌─────────────────────────────────────────────────────────────┐
│  v0.2  │ Hamming Distance + Skip solid colors               │
│        │ - Add hammingDistance() to hash.js                 │
│        │ - Add findMatchingHash() to content.js             │
│        │ - Add isSolidColor() filter                        │
├─────────────────────────────────────────────────────────────┤
│  v0.3  │ IntersectionObserver + Concurrency                 │
│        │ - Only hash visible/near-visible images            │
│        │ - Increase to 3 concurrent hash operations         │
│        │ - Add image size cap in background.js              │
├─────────────────────────────────────────────────────────────┤
│  v0.4  │ Robustness + Accessibility                         │
│        │ - Track unhashable URLs                            │
│        │ - Use currentSrc for responsive images             │
│        │ - Add tooltips and ARIA labels                     │
├─────────────────────────────────────────────────────────────┤
│  v0.5  │ Popup UI                                           │
│        │ - Toggle on/off                                    │
│        │ - Sensitivity slider                               │
│        │ - Stats display                                    │
├─────────────────────────────────────────────────────────────┤
│  v1.0  │ Production Release                                 │
│        │ - IndexedDB caching with TTL/LRU                   │
│        │ - Tightened manifest permissions                   │
│        │ - Polished UX                                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Immediate Next Actions

1. [ ] Add `hammingDistance()` to `hash.js` and expose on `window.ThumbHash`
2. [ ] Add `findMatchingHash()` to `content.js`
3. [ ] Add `isSolidColor()` filter
4. [ ] Test with near-duplicate images (JPEG recompressed versions)
5. [ ] Bump version to 0.2.0

---

## Architecture: Current vs. Target

### Current Flow

```
MutationObserver (1s debounce)
        │
        ▼
  querySelectorAll('img')
        │
        ▼
  Queue ALL valid images
        │
        ▼
  Background fetch (1 at a time, 200ms gap)
        │
        ▼
  Compute dHash
        │
        ▼
  EXACT match lookup  ← Problem: misses near-duplicates
        │
        ▼
  Apply styling
```

### Target Flow (v0.3+)

```
MutationObserver (1s debounce)
        │
        ▼
  IntersectionObserver (observe new imgs)
        │
        ▼
  Image enters viewport?
        │ YES
        ▼
  Check cache (already hashed?)
        │ NO
        ▼
  Queue for hashing (3 concurrent max)
        │
        ▼
  Background fetch (with size cap)
        │
        ▼
  Compute dHash
        │
        ▼
  HAMMING DISTANCE lookup (threshold ≤5)  ← Fixed!
        │
        ▼
  Apply styling + cache result
```

---

## Testing Checklist

- [ ] Near-duplicate detection (JPEG recompression)
- [ ] Exact duplicate detection (same image, different URLs)
- [ ] Virtualized scrolling (images appearing/disappearing)
- [ ] Fast scroll (should not queue 500 images)
- [ ] CORS-blocked images (should fail gracefully)
- [ ] Large images (>2MB should be skipped)
- [ ] Solid-color placeholders (should be ignored)
- [ ] Responsive images (`srcset`/`currentSrc`)

---

*Document created: December 9, 2025*
*Based on: recommendations-3.md, RECOMMENDATIONS.md, recommendations2.md*

