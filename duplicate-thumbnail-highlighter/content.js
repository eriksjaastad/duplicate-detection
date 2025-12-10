console.log("[DuplicateHighlighter] Loaded");

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
 * Maximum number of failed URLs to track.
 * Prevents memory leak if many images fail to load (404s, CORS issues, etc).
 */
const MAX_FAILED_ENTRIES = 1000;

// --- VISUAL STYLING ---

/**
 * Returns CSS styles based on duplicate count.
 * Count 1 = New (No style)
 * Count 2 = Blue (Low dup)
 * Count 5+ = Trending toward Red
 * Count 10+ = Red (High dup)
 */
function styleForCount(count) {
    if (count <= 1) return null;

    const maxCount = 10; // Cap at 10 for max redness
    const clamped = Math.min(count, maxCount);
    const t = (clamped - 1) / (maxCount - 1); // 0..1 range

    // Color-Blind Friendly Palette (Blue -> Orange/Red)
    const hue = 200 - (200 * t);

    // Pattern opacity
    const alpha = 0.3;

    // Generate Striped Background (wider stripes for low count, tighter for high)
    const stripeWidth = 20 - (15 * t); // 20px -> 5px
    const colorA = `hsla(${hue}, 100%, 50%, ${alpha})`;
    const colorB = `hsla(${hue}, 100%, 50%, 0.05)`;

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
        backgroundImage: pattern,
        badgeColor: '#fff',
        zIndex: 1000 + count
    };
}

/**
 * Applies visual highlighting to an image element.
 */
function markDuplicateThumbnail(img, count) {
    const parent = img.parentElement;
    if (!parent) return;

    // Cleanup existing decorations
    const existingBadge = parent.querySelector('.dup-badge');
    if (existingBadge) existingBadge.remove();
    const existingOverlay = parent.querySelector('.dup-overlay');
    if (existingOverlay) existingOverlay.remove();

    // Clear styles if count is low
    if (count <= 1) {
        img.style.outline = '';
        return;
    }

    const styles = styleForCount(count);

    // Apply Outline
    img.style.outline = styles.outline;
    img.style.outlineOffset = styles.outlineOffset;

    // Setup Parent for absolute positioning
    const computedStyle = window.getComputedStyle(parent);
    if (computedStyle.position === 'static') {
        parent.style.position = 'relative';
    }

    // Apply Overlay with stripe pattern
    const overlay = document.createElement('div');
    overlay.className = 'dup-overlay';
    Object.assign(overlay.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        backgroundImage: styles.backgroundImage,
        pointerEvents: 'none',
        zIndex: styles.zIndex - 1,
        borderRadius: 'inherit'
    });
    parent.appendChild(overlay);

    // Apply Badge with count
    const badge = document.createElement('div');
    badge.className = 'dup-badge';
    badge.innerText = count;
    badge.setAttribute('title', `Duplicate: ${count} copies on this page`);

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

// --- HASH MATCHING ---

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

/**
 * Get the effective source URL for an image (handles responsive images).
 */
function getImageSrc(img) {
    return img.currentSrc || img.src;
}

// --- MEMORY MANAGEMENT ---

// Track which image SRC URLs we've already processed
// src URL -> hash
const processedSrcUrls = new Map();

// Track which image SRCs share the same hash (for finding duplicates)
// hash -> Set of src URLs
const hashToSrcUrls = new Map();

// Track URLs that failed to hash (avoid retry loops)
const failedUrls = new Set();

/**
 * Evicts oldest entries from caches when they exceed their limits.
 */
function evictOldestEntries() {
    // Evict from processedSrcUrls and hashToSrcUrls
    if (processedSrcUrls.size > MAX_CACHE_ENTRIES) {
        const entriesToRemove = processedSrcUrls.size - MAX_CACHE_ENTRIES;
        let removed = 0;

        for (const [src, hash] of processedSrcUrls) {
            if (removed >= entriesToRemove) break;

            processedSrcUrls.delete(src);

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

    // Evict from failedUrls (clear oldest half when limit exceeded)
    if (failedUrls.size > MAX_FAILED_ENTRIES) {
        const entriesToRemove = Math.floor(failedUrls.size / 2);
        let removed = 0;

        for (const url of failedUrls) {
            if (removed >= entriesToRemove) break;
            failedUrls.delete(url);
            removed++;
        }

        console.log(`[DuplicateHighlighter] Evicted ${removed} failed URL entries`);
    }
}

/**
 * Update all visible images that share a hash with new duplicate count.
 */
function updateAllMatchingImages(targetHash) {
    const matchingSrcs = hashToSrcUrls.get(targetHash);
    if (!matchingSrcs || matchingSrcs.size <= 1) return;

    document.querySelectorAll('img').forEach(pageImg => {
        const pageSrc = getImageSrc(pageImg);
        if (matchingSrcs.has(pageSrc)) {
            markDuplicateThumbnail(pageImg, matchingSrcs.size);
        }
    });
}

// --- PAGE PROCESSING ---

/**
 * Process a single image: hash it and check for duplicates.
 * Called when an image enters the viewport.
 */
function processImage(img) {
    const src = getImageSrc(img);

    // Skip if already processed - just re-apply highlighting
    if (processedSrcUrls.has(src)) {
        const knownHash = processedSrcUrls.get(src);
        const srcSet = hashToSrcUrls.get(knownHash);
        if (srcSet && srcSet.size > 1) {
            markDuplicateThumbnail(img, srcSet.size);
        }
        return;
    }

    // Skip if previously failed
    if (failedUrls.has(src)) return;

    // Queue for hashing (non-blocking - allows parallel processing)
    window.ThumbHash.queueHash(src).then((realHash) => {
        // Handle failure
        if (!realHash) {
            failedUrls.add(src);
            return;
        }

        // Skip solid-color placeholders
        if (isSolidColor(realHash)) return;

        // Find matching hash (exact or near-duplicate via Hamming)
        const matchKey = findMatchingHash(realHash, hashToSrcUrls);
        const targetKey = matchKey || realHash;

        // Record this src -> hash mapping
        processedSrcUrls.set(src, targetKey);

        // Track all src URLs that share this hash
        if (!hashToSrcUrls.has(targetKey)) {
            hashToSrcUrls.set(targetKey, new Set());
        }
        hashToSrcUrls.get(targetKey).add(src);

        const matchingSrcs = hashToSrcUrls.get(targetKey);

        // If multiple DIFFERENT src URLs produce the same hash = visual duplicate
        if (matchingSrcs.size > 1) {
            console.log(`%c[DUPLICATE FOUND]`, 'background: #c41; color: white; padding: 2px 6px; border-radius: 3px;', {
                hash: targetKey.substring(0, 16) + '...',
                count: matchingSrcs.size
            });

            // Mark all currently visible images that match this hash
            updateAllMatchingImages(targetKey);
        }
    });
}

/**
 * Check if an image is valid for processing.
 */
function isValidImage(img) {
    if (!img.src || img.src.startsWith('data:')) return false;
    return img.naturalWidth > 100 && img.naturalHeight > 50;
}

// --- INTERSECTION OBSERVER (VIEWPORT-BASED PROCESSING) ---

// Track images we're already observing to avoid duplicates
const observedImages = new WeakSet();

/**
 * IntersectionObserver that triggers hashing when images enter viewport.
 * Uses rootMargin to pre-fetch images slightly before they're visible.
 */
const imageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (entry.isIntersecting) {
            const img = entry.target;
            
            // Stop observing this image
            imageObserver.unobserve(img);
            
            // Process it if valid
            if (isValidImage(img)) {
                processImage(img);
            }
        }
    }
}, {
    rootMargin: '500px', // Start processing 500px before image is visible
    threshold: 0
});

/**
 * Scan the page for new images and observe them.
 * Called on initial load and when DOM changes.
 */
function observeNewImages() {
    // Evict old entries if cache is getting too large
    evictOldestEntries();

    const imgs = document.querySelectorAll('img');
    
    for (const img of imgs) {
        // Skip if already observing or processed
        if (observedImages.has(img)) continue;
        
        const src = getImageSrc(img);
        if (processedSrcUrls.has(src) || failedUrls.has(src)) {
            // Already processed - just re-apply highlighting if needed
            if (processedSrcUrls.has(src)) {
                const knownHash = processedSrcUrls.get(src);
                const srcSet = hashToSrcUrls.get(knownHash);
                if (srcSet && srcSet.size > 1) {
                    markDuplicateThumbnail(img, srcSet.size);
                }
            }
            continue;
        }

        // Start observing this image
        observedImages.add(img);
        imageObserver.observe(img);
    }
}

// Legacy function name for compatibility with manual rescan shortcut
function processPage() {
    observeNewImages();
}

// --- KEYBOARD SHORTCUTS ---

// Alt + Shift + R = Reset all data and reload
window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyR') {
        console.log("[DuplicateHighlighter] Resetting...");
        processedSrcUrls.clear();
        hashToSrcUrls.clear();
        failedUrls.clear();
        location.reload();
    }
});

// Alt + Shift + D = Debug dump
window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyD') {
        console.log('%c[DEBUG DUMP]', 'background: #36c; color: white; padding: 2px 6px; border-radius: 3px;');
        console.log('Processed URLs:', processedSrcUrls.size);
        console.log('Unique hashes:', hashToSrcUrls.size);
        console.log('Failed URLs:', failedUrls.size);
        
        // Show duplicate groups
        const duplicates = [];
        for (const [hash, srcSet] of hashToSrcUrls) {
            if (srcSet.size > 1) {
                duplicates.push({
                    hash: hash.substring(0, 16) + '...',
                    count: srcSet.size,
                    urls: Array.from(srcSet).map(u => u.substring(0, 60) + '...')
                });
            }
        }
        console.table(duplicates);
    }
});

// Alt + Shift + S = Rescan page now
window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyS') {
        console.log("[DuplicateHighlighter] Manual rescan triggered");
        processPage();
    }
});

// --- MUTATION OBSERVER (SPA SUPPORT) ---

let debounceTimer = null;
const domObserver = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(observeNewImages, 500); // Faster debounce since we're just observing
});

domObserver.observe(document.body, { childList: true, subtree: true });

console.log("[DuplicateHighlighter] Ready. Using IntersectionObserver + 5 parallel fetches.");

// Initial scan
setTimeout(observeNewImages, 500);
