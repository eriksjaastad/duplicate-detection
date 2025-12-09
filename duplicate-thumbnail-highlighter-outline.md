# Duplicate Thumbnail Highlighter – Project Outline

## 1. Goal

Build a **local browser extension** that:

- Watches pages with ~60 video thumbnails per page.
- Computes a **content-based hash** of each thumbnail (first frame image).
- Tracks how many times each thumbnail has been seen across all pages and all time.
- Visually **highlights duplicates** with color-graded outlines and badges so it’s obvious which videos are repeated.

No reliance on:

- Submitter name (people change names).
- Video link/URL (each submission has a unique link even when it’s the same content).

The only thing we trust is the **thumbnail pixels** themselves.


## 2. High-Level Design

### 2.1 Core Idea

Per thumbnail, we want to answer:

> “Have I seen this thumbnail before, and if so, how many times?”

We do this by:

1. **Hashing the thumbnail** (using a perceptual hash over the pixels).
2. **Storing the hash locally** in the browser (IndexedDB), with a simple `count` of how often it’s appeared.
3. **On each new page**, computing hashes for the 60 thumbnails and checking if each hash already exists in the local DB.

This works even when:

- There are *hundreds of thousands or millions* of total thumbnails.
- Links and submitter names are always different.
- We only have access to what the page loads in the browser (no backend access).


### 2.2 Storage Choice: IndexedDB

- Use **IndexedDB** (and/or extension `storage`) for persistence.
- Designed for **millions of small records** with indexed lookups.
- Exact-key lookup by `hash` is fast even at large scales.

Object store:

- Name: `thumbnails`
- Key: `hash` (primary key)
- Value: `{ hash, count, firstSeenAt, lastSeenAt }`


### 2.3 Data Model (Minimal)

We don’t need names, URLs, or external IDs to detect duplicates.

**Object shape:**

```js
{
  hash: string,      // 64-bit-ish perceptual hash rendered as a string/key
  count: number,     // number of times we've seen this thumbnail
  firstSeenAt: number, // timestamp (ms since epoch)
  lastSeenAt: number   // timestamp (ms since epoch)
}
```

We can add more fields later if needed, but this is enough to drive duplicate highlighting.


## 3. Extension Structure

Folder layout on the dev machine:

```text
duplicate-highlighter/
  manifest.json
  content.js
  hash.js        // thumbnail hashing via canvas
  db.js          // IndexedDB helper functions
  styles.css     // (optional) extra styles for badges, etc.
```


### 3.1 `manifest.json` (Chrome MV3 Example)

```json
{
  "manifest_version": 3,
  "name": "Duplicate Thumbnail Highlighter",
  "version": "0.1.0",
  "description": "Highlights videos whose thumbnails have been seen before.",
  "permissions": ["storage"],
  "host_permissions": [
    "https://public.example.com/*",
    "https://admin.example.com/*"
  ],
  "content_scripts": [
    {
      "matches": [
        "https://public.example.com/*",
        "https://admin.example.com/*"
      ],
      "js": ["db.js", "hash.js", "content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_title": "Duplicate Highlighter"
  }
}
```

Notes:

- Replace `public.example.com` and `admin.example.com` with the **real domains** of:
  - the public site (for testing), and
  - the admin portal (for the real workflow).
- `run_at: "document_idle"` means the content script runs after the page has largely finished loading, so most thumbnails should be available.


## 4. Thumbnail Hashing Strategy

### 4.1 Why Perceptual Hashing

We’re hashing **thumbnail pixels**, not filenames or URLs.

A **perceptual hash** (pHash/dHash/aHash) gives us:

- Stable hashes for images that look visually identical (or very close).
- Small fixed-length values (~64 bits) that are easy to store and compare.

For v1, we can:

- Use a simple dHash-like algorithm:
  - Resize to a small grayscale image (e.g. 9×8 or 8×9).
  - Compare adjacent pixels to build a 64-bit fingerprint.
- Treat equal hashes as “same thumbnail”.

### 4.2 Basic Flow in the Browser

For each thumbnail `<img>`:

1. Wait until it has loaded (`img.complete && img.naturalWidth > 0`).
2. Draw it into an offscreen `<canvas>` (e.g. 32×32).
3. Read back the pixels from the canvas.
4. Run the dHash/pHash logic to produce a 64-bit hash.
5. Convert that to a string key (hex or base64) for storage in IndexedDB.


## 5. IndexedDB Helper (`db.js`)

### 5.1 Opening the DB

```js
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('duplicateThumbsDB', 1);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('thumbnails')) {
        db.createObjectStore('thumbnails', { keyPath: 'hash' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

### 5.2 Get/Put Helpers

```js
async function getThumbnailRecord(hash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('thumbnails', 'readonly');
    const store = tx.objectStore('thumbnails');
    const req = store.get(hash);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function upsertThumbnailRecord(hash, updater) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('thumbnails', 'readwrite');
    const store = tx.objectStore('thumbnails');

    const getReq = store.get(hash);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const now = Date.now();
      const updated = updater(existing, now);

      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}
```

Usage for v1:

```js
// When we’ve computed a hash for a thumbnail:
const record = await getThumbnailRecord(hash);

if (!record) {
  await upsertThumbnailRecord(hash, () => ({
    hash,
    count: 1,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now()
  }));
} else {
  await upsertThumbnailRecord(hash, (existing, now) => ({
    ...existing,
    count: existing.count + 1,
    lastSeenAt: now
  }));
}
```


### 5.3 Wiping All Data (for Testing)

Useful when testing on the public site before switching to the admin portal.

```js
async function clearAllThumbs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('thumbnails', 'readwrite');
    const store = tx.objectStore('thumbnails');
    const req = store.clear();

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
```

Temporary dev-only shortcut in `content.js` (for local testing only):

```js
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.key === 'X') {
    clearAllThumbs().then(() => {
      console.log('All thumbnail hashes cleared');
    });
  }
});
```


## 6. Visual Highlighting Design

We want two things at a glance:

1. **Is this a duplicate or new?**
2. **How many times have we seen it before?** (rough magnitude)

### 6.1 Visual Elements

Per duplicate thumbnail:

- **Colored outline** around the image (using `outline`, not `border`).
- **Outline thickness** scales with `count`.
- A small **badge** in a corner showing the exact `count` value.

Color progression:

- **Green → Yellow → Red** as `count` increases.
- Cap at a maximum (e.g. `maxCount = 50`) so we don’t “over-blow” styles for absurdly high counts.


### 6.2 Mapping Count → Color + Thickness

```js
function styleForCount(count) {
  const maxCount = 50;
  const clamped = Math.min(count, maxCount);
  const t = clamped / maxCount; // 0 (new-ish) → 1 (max duped)

  // Hue 120 (green) → 0 (red)
  const hue = 120 - 120 * t;

  // Border thickness 2px → 5px
  const thickness = 2 + 3 * t;

  return {
    outline: `${thickness}px solid hsl(${hue}, 90%, 50%)`,
    outlineOffset: '2px',
    badgeBg: `hsl(${hue}, 90%, 35%)`
  };
}
```


### 6.3 Marking a Duplicate Thumbnail (`content.js`)

```js
function markDuplicateThumbnail(imgElement, count) {
  const styles = styleForCount(count);

  // Add outline around the image itself
  imgElement.style.outline = styles.outline;
  imgElement.style.outlineOffset = styles.outlineOffset;

  // Find a container to attach a badge
  const container =
    imgElement.closest('.video-card, .item, .whatever') || imgElement.parentElement;
  if (!container) return;

  if (!container.style.position) {
    container.style.position = 'relative';
  }

  const badge = document.createElement('div');
  badge.textContent = count;
  badge.className = 'dup-badge';
  badge.style.position = 'absolute';
  badge.style.top = '4px';
  badge.style.right = '4px';
  badge.style.padding = '2px 6px';
  badge.style.borderRadius = '999px';
  badge.style.fontSize = '10px';
  badge.style.fontWeight = 'bold';
  badge.style.color = '#fff';
  badge.style.background = styles.badgeBg;
  badge.style.zIndex = 9999;
  badge.style.pointerEvents = 'none';

  container.appendChild(badge);
}
```

You’ll eventually customize the `.closest()` selector for whatever DOM structure the site uses for each thumbnail.


## 7. Content Script Flow (`content.js`)

High-level logic on each page that shows ~60 thumbnails:

1. **Find the thumbnails** (e.g., all `<img>` elements inside specific containers).
2. For each thumbnail:
   - Ensure it’s loaded.
   - Compute perceptual hash via `hash.js` (canvas-based).
   - Look up `hash` in IndexedDB.
   - If no record:
     - Insert `{hash, count: 1, ...}`.
   - If record exists:
     - Increment `count` and update `lastSeenAt`.
     - Call `markDuplicateThumbnail(img, count)` to visually highlight it.

Pseudocode:

```js
async function processPageThumbnails() {
  const thumbs = findThumbnailsOnPage(); // site-specific selector

  for (const img of thumbs) {
    await ensureImageLoaded(img);  // wait until naturalWidth > 0

    const hash = await computeThumbHash(img);  // from hash.js

    const record = await getThumbnailRecord(hash);
    let updated;

    if (!record) {
      updated = await upsertThumbnailRecord(hash, (existing, now) => ({
        hash,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now
      }));
    } else {
      updated = await upsertThumbnailRecord(hash, (existing, now) => ({
        ...existing,
        count: existing.count + 1,
        lastSeenAt: now
      }));
    }

    if (updated.count > 1) {
      markDuplicateThumbnail(img, updated.count);
    }
  }
}
```

This function can be run:

- Once at page load (`document_idle`).
- Again on scroll or when new content is lazy-loaded (possibly throttled).


## 8. Testing Strategy

### 8.1 On Personal Machine (Dev Box)

1. Implement extension in the `duplicate-highlighter` folder.
2. Load it as an unpacked extension via:
   - `chrome://extensions` → **Developer mode** → **Load unpacked**.
3. Test on the **public site**:
   - First pass: all “new” (no outlines yet).
   - Second pass / next pages: duplicates should now be getting outlines + badges.
4. Use `clearAllThumbs()` (e.g., Ctrl+Alt+X dev shortcut) to wipe DB and re-test scenarios.

Once behavior feels right, add specific URL patterns for the admin portal in `manifest.json` if not already there.


### 8.2 Switching to Admin Portal

- Keep the same extension code.
- Ensure the `matches` (host permissions + content script matches) include the admin portal domain.
- Optionally wipe the DB once more so the admin portal starts with a clean slate of hashes.

Now the extension:

- Runs on the admin pages.
- Hashes the 60 thumbnails per page.
- Highlights duplicates based on **real admin submissions** going forward.


## 9. Deploying to Work Machine (No Dev Tools Installed)

Because the work machine is “browser-only” (no coding tools installed), the plan is:

1. **Finish building + testing** on the personal machine.
2. Create a **ZIP file** of the `duplicate-highlighter` folder (with `manifest.json` in the root).
3. Transfer the ZIP to the work computer (email, USB, cloud, etc.).
4. On the work browser:
   - If allowed to use Developer Mode:
     - Unzip the folder.
     - Go to `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the folder.
   - If Developer Mode is restricted:
     - Options:
       - Publish the extension as a **private/unlisted** item in the Chrome Web Store and install from there, or
       - Have IT install the extension via their centralized extension management.

No local dev tooling is required on the work laptop—just the ability to install an extension.


## 10. Next Steps

1. Implement a simple `computeThumbHash(img)` in `hash.js` (dHash-style).
2. Wire up `content.js` to:
   - Discover the correct thumbnail DOM nodes on the real site.
   - Call `computeThumbHash()` and IndexedDB helpers.
   - Apply `markDuplicateThumbnail()` for duplicates.
3. Iterate on the **visual design** of outlines + badges until it feels good:
   - Adjust hue/brightness curve.
   - Adjust thickness mapping.
   - Possibly add a legend for your own reference (e.g., green=seen < 5, yellow=5–20, red=>20).
4. Once v1 is stable on the public site, move to the admin portal and test with real data.
