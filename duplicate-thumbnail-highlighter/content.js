console.log("Duplicate Thumbnail Highlighter: Loaded");

// --- CONFIGURATION ---

/**
 * Hamming distance threshold for near-duplicate detection.
 * - Lower = stricter matching (fewer false positives, may miss similar images)
 * - Higher = looser matching (catches more duplicates, but may have false positives)
 *
 * With a 32x31 dHash (992 bits / 248 hex chars), typical thresholds:
 * - 0: Exact match only
 * - 5: Very similar images (compression artifacts, slight crops) [RECOMMENDED]
 * - 10: Moderately similar (same scene, different quality)
 * - 15+: Loose matching (may catch unrelated images)
 */
const HAMMING_THRESHOLD = 5;

/**
 * Maximum number of entries to keep in memory maps.
 * Prevents unbounded memory growth on infinite-scroll pages.
 * When limit is reached, oldest entries are evicted (LRU-style).
 */
const MAX_CACHE_ENTRIES = 5000;

/**
 * Returns CSS styles based on duplicate count.
 * Count 1 = New (No style)
 * Count 2 = Green (Low dup)
 * Count 5 = Yellow
 * Count 10+ = Red
 */
function styleForCount(count) {
    if (count <= 1) return null;

    const maxCount = 10; // Cap at 10 for max redness
    const clamped = Math.min(count, maxCount);
    const t = (clamped - 1) / (maxCount - 1); // 0..1 range

    // Color-Blind Friendly Palette (Blue -> Orange/Magenta) & Patterns
    // Low count = Blue-ish, High count = Orange/Red-ish
    // We keep HSL but shift hue: 200 (Blue) -> 0 (Red)
    const hue = 200 - (200 * t);

    // Pattern opacity
    const alpha = 0.3;

    // Generate Striped Background
    // Low count = Wide stripes
    // High count = Tight stripes
    const stripeWidth = 20 - (15 * t); // 20px -> 5px
    const colorA = `hsla(${hue}, 100%, 50%, ${alpha})`;
    const colorB = `hsla(${hue}, 100%, 50%, 0.05)`; // Almost clear

    const pattern = `repeating-linear-gradient(
        45deg,
        ${colorA},
        ${colorA} 2px,
        ${colorB} 2px,
        ${colorB} ${stripeWidth}px
    )`;

    return {
        outline: `3px solid hsl(${hue}, 100%, 50%)`,
        outlineOffset: '-4px',
        badgeBg: `hsl(${hue}, 100%, 30%)`,
        overlayBg: 'transparent', // We use backgroundImage now
        backgroundImage: pattern,
        badgeColor: '#fff',
        zIndex: 1000 + count
    };
}

/**
 * Applies visual highlighting to an image element.
 */
function markDuplicateThumbnail(img, count) {
    // 1. Cleanup previous widgets
    const parent = img.parentElement;
    if (!parent) return;

    // Cleanup existing
    const existingBadge = parent.querySelector('.dup-badge');
    if (existingBadge) existingBadge.remove();
    const existingOverlay = parent.querySelector('.dup-overlay');
    if (existingOverlay) existingOverlay.remove();

    // 2. Clear styles if count is low
    if (count <= 1) {
        img.style.outline = '';
        return;
    }

    // 3. Compute Styles
    const styles = styleForCount(count);

    // 4. Apply Outline (still useful for sharp edge)
    img.style.outline = styles.outline;
    img.style.outlineOffset = styles.outlineOffset;

    // 5. Setup Parent
    const computedStyle = window.getComputedStyle(parent);
    if (computedStyle.position === 'static') {
        parent.style.position = 'relative';
    }

    // 6. Apply Overlay
    const overlay = document.createElement('div');
    overlay.className = 'dup-overlay';
    Object.assign(overlay.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        backgroundImage: styles.backgroundImage, // Apply Pattern
        pointerEvents: 'none', // Allow clicks to pass through
        zIndex: styles.zIndex - 1,
        borderRadius: 'inherit' // Try to match parent border radius
    });
    parent.appendChild(overlay);

    // 7. Apply Badge
    const badge = document.createElement('div');
    badge.className = 'dup-badge';
    badge.innerText = count;

    Object.assign(badge.style, {
        position: 'absolute',
        top: '4px',
        right: '4px',
        backgroundColor: styles.badgeBg,
        color: styles.badgeColor,
        padding: '2px 6px',
        borderRadius: '12px',
        fontSize: '12px',
        fontWeight: 'bold',
        zIndex: styles.zIndex,
        boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
        pointerEvents: 'none',
        fontFamily: 'sans-serif'
    });

    parent.appendChild(badge);
}

/**
 * Find a matching hash using exact match first, then Hamming distance.
 * Returns the matching hash key or null.
 */
function findMatchingHash(newHash, hashMap) {
    if (hashMap.has(newHash)) return newHash;

    for (const existingHash of hashMap.keys()) {
        if (window.ThumbHash.hammingDistance(newHash, existingHash) <= HAMMING_THRESHOLD) {
            return existingHash;
        }
    }
    return null;
}

/**
 * Skip solid-color placeholders that produce uniform hashes.
 */
function isSolidColor(hash) {
    if (!hash) return false;
    return /^0+$/.test(hash) || /^f+$/.test(hash);
}

// --- MEMORY MANAGEMENT ---

// Track which image SRC URLs we've already processed (survives virtualized scrolling)
// src URL -> { hash, timestamp }
const processedSrcUrls = new Map();

// Track which image SRCs share the same hash (for finding duplicates)
// hash -> Set of src URLs
const hashToSrcUrls = new Map();

/**
 * Evicts oldest entries from the cache when it exceeds MAX_CACHE_ENTRIES.
 * Uses insertion order (Map maintains insertion order in JS).
 */
function evictOldestEntries() {
    if (processedSrcUrls.size <= MAX_CACHE_ENTRIES) return;

    const entriesToRemove = processedSrcUrls.size - MAX_CACHE_ENTRIES;
    let removed = 0;

    for (const [src, data] of processedSrcUrls) {
        if (removed >= entriesToRemove) break;

        // Remove from processedSrcUrls
        processedSrcUrls.delete(src);

        // Remove from hashToSrcUrls
        const hash = data.hash || data; // Handle both old and new format
        if (hashToSrcUrls.has(hash)) {
            const srcSet = hashToSrcUrls.get(hash);
            srcSet.delete(src);
            if (srcSet.size === 0) {
                hashToSrcUrls.delete(hash);
            }
        }
        removed++;
    }

    if (removed > 0) {
        console.log(`[DuplicateHighlighter] Evicted ${removed} old entries from cache`);
    }
}

async function processPage() {
    const imgs = document.querySelectorAll('img');

    const validImgs = Array.from(imgs).filter(img => {
        // Skip invalid images
        if (!img.src || img.src.startsWith('data:')) return false;
        const isValid = img.naturalWidth > 100 && img.naturalHeight > 50;
        return isValid;
    });

    // Evict old entries if cache is getting too large
    evictOldestEntries();

    for (const img of validImgs) {
        const src = img.currentSrc || img.src;

        // Already processed this src URL?
        if (processedSrcUrls.has(src)) {
            // We already know its hash - just re-apply styling if it's a duplicate
            const cachedData = processedSrcUrls.get(src);
            const knownHash = cachedData.hash || cachedData; // Handle both formats
            const srcSet = hashToSrcUrls.get(knownHash);
            if (srcSet && srcSet.size > 1) {
                markDuplicateThumbnail(img, srcSet.size);
            }
            continue;
        }

        // New src URL - need to hash it
        try {
            const realHash = await window.ThumbHash.queueHash(src);
            if (!realHash || isSolidColor(realHash)) continue;

            // Find matching hash (exact or near-duplicate)
            const matchKey = findMatchingHash(realHash, hashToSrcUrls);
            const targetKey = matchKey || realHash;

            // Record this src -> hash mapping with timestamp
            processedSrcUrls.set(src, { hash: targetKey, timestamp: Date.now() });

            // Track all src URLs that share this hash
            if (!hashToSrcUrls.has(targetKey)) {
                hashToSrcUrls.set(targetKey, new Set());
            }
            hashToSrcUrls.get(targetKey).add(src);

            const matchingSrcs = hashToSrcUrls.get(targetKey);

            // Persist to IndexedDB for cross-session duplicate detection
            const pageUrl = window.location.href;
            try {
                await window.ThumbDB.upsertThumbnailRecord(targetKey, pageUrl);
            } catch (dbError) {
                console.warn('[DuplicateHighlighter] Failed to persist to IndexedDB:', dbError);
            }

            // If multiple DIFFERENT src URLs produce the same hash = visual duplicate
            if (matchingSrcs.size > 1) {
                console.log(`%c[DUPLICATE FOUND]`, 'background: red; color: white; padding: 2px 6px;', {
                    hash: targetKey.substring(0, 16) + '...',
                    matchingSrcUrls: Array.from(matchingSrcs)
                });

                // Mark all currently visible images that match this hash
                document.querySelectorAll('img').forEach(pageImg => {
                    if (matchingSrcs.has(pageImg.src)) {
                        markDuplicateThumbnail(pageImg, matchingSrcs.size);
                    }
                });
            }
        } catch (error) {
            console.warn('[DuplicateHighlighter] Failed to process image:', src, error);
        }
    }
}

// Helper to clear DB from console
window.resetAllData = async () => {
    console.log("Resetting all data...");
    await window.ThumbDB.clearAllThumbs();
    location.reload();
};

// Keyboard Shortcut: Alt + Shift + R = Reset
window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyR') {
        window.resetAllData();
    }
});

// Keyboard Shortcut: Alt + Shift + D = Debug dump
window.addEventListener('keydown', async (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyD') {
        console.log('%c[DEBUG DUMP] Fetching all stored hashes...', 'background: blue; color: white; padding: 2px 6px;');
        const allRecords = await window.ThumbDB.getAllRecords();
        console.log(`Found ${allRecords.length} unique hashes in database:`);
        console.table(allRecords.map(r => ({
            hash: r.hash.substring(0, 16) + '...',
            count: r.count,
            pages: r.urls?.length || 0,
            urls: r.urls?.join(' | ').substring(0, 100) || 'N/A'
        })));
        console.log('Full records:', allRecords);
    }
});

// Start logic
// --- MUTATION OBSERVER (SPA SUPPORT) ---

let debounceTimer = null;
const observer = new MutationObserver(() => {
    // When DOM changes, wait for a quiet period (1 sec) then scan
    // This prevents running 100 times while React is rendering a list
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processPage, 1000);
});

// Start observing the document body for added nodes
observer.observe(document.body, { childList: true, subtree: true });

console.log("[DuplicateHighlighter] MutationObserver started. Watching for content changes...");

// Initial check in case content is already there
setTimeout(processPage, 1000);
