# Duplicate Thumbnail Highlighter — TODO

**Last Update:** December 10, 2025

---

## 🔴 Priority: Investigate Performance

**Issue:** On pages with many thumbnails, initial scan is slow. Highlighting is faster after scrolling (once hashes are cached).

**Observations:**
- Viewport scrolling seems to trigger some display actions
- Re-marking already-hashed images is fast
- Initial hashing/fetching is the bottleneck
- Page layout is 5 columns, variable rows (can be hundreds of images)
- User mostly checks recent submissions (top of page), not full history

**Recommended First Implementation: 5 Parallel + IntersectionObserver**

This combo gives the best results for the actual use case:
- **5 parallel fetches** — matches the 5-column layout, stays under browser's 6-connection limit
- **IntersectionObserver** — only hash images as they scroll into view
- Result: First screenful (~15-20 images) shows duplicates almost instantly, then each row lights up as you scroll
- Bonus: Old images at bottom never get processed unless you scroll there = no wasted work

**All Options (ranked by risk/reward):**

1. **IntersectionObserver** — Only hash images as they enter/approach viewport ⭐ LOW RISK
   - Currently we queue ALL valid images on page scan
   - Could defer off-screen images until user scrolls near them
   - Add `rootMargin: '500px'` to pre-fetch just before visible

2. **Increase Concurrency** — Currently processing 1 image at a time with 200ms gap ⭐ LOW RISK
   - Increase to 5 parallel hash operations (matches 5-column layout)
   - Browser limits ~6 concurrent connections per origin anyway
   - Background fetch is the slowest part; parallelizing helps

3. **Batch DOM Updates** — Each badge/overlay add is a separate DOM mutation
   - Could collect all updates and apply in one `requestAnimationFrame`
   - Reduces layout thrashing

4. **requestIdleCallback** — Queue non-visible image hashing during idle time
   - Lower priority than visible images
   - Good for infinite-scroll pages

5. **Web Worker for Hashing** — Move canvas/dHash computation off main thread
   - Would require passing image data to worker
   - More complex but eliminates jank

---

## ✅ Completed

- [x] Core duplicate detection working
- [x] Hamming distance for near-duplicates (threshold: 5)
- [x] Visual highlighting with count badges
- [x] MutationObserver for SPA/lazy-loaded content
- [x] CORS bypass via background fetch
- [x] Memory management (LRU eviction at 5000 entries)
- [x] Failed URL tracking (capped at 1000)
- [x] Removed unused IndexedDB code
- [x] Fixed extension conflict with Name Highlighter

---

## 🔲 Future Ideas

- [ ] Extension popup UI (toggle, sensitivity slider, stats)
- [ ] Adjust Hamming threshold via popup
- [ ] Export duplicate report (list of duplicate groups)
- [ ] Cross-session persistence (optional, via IndexedDB)
- [ ] Site-specific settings

---

## Debug Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Alt+Shift+R | Reset all data and reload |
| Alt+Shift+D | Debug dump (show stats + duplicate groups) |
| Alt+Shift+S | Manual rescan |

---

## Tech Notes

- **Hash algorithm:** dHash (difference hash), 32x32 → 992 bits
- **Matching:** Exact match first, then Hamming distance ≤ 5
- **Throttle:** 200ms between hash operations (1 at a time)
- **Debounce:** 1 second after DOM mutations before rescanning
- **Target site:** `kwiky.com/*`
