# Duplicate Thumbnail Highlighter – Sprint Plan

This is a **high-level sprint breakdown** to get from idea → working browser extension → deployed on work machine, without getting bogged down in low-level details.

Assume “sprints” are flexible blocks (e.g. a few hours or a day of focus).


## Overall Goal

Build a **browser extension** that:

- Watches pages with ~60 video thumbnails.
- Computes a **perceptual hash** of each thumbnail.
- Stores counts per hash in **IndexedDB** (`hash → { count, firstSeenAt, lastSeenAt }`).
- Visually **highlights duplicates** with color-graded outlines and a small badge showing how many times a thumbnail has appeared.

No personal data, no server calls, no external storage.


---

## Sprint 0 – Repo & Baseline Skeleton

**Objective:** Have a minimal extension that loads on the target site and runs a basic content script, ensuring no early blockers like CORS/Canvas tainting.

**Detailed Tasks:**
- [ ] **Project Setup**
    - [ ] Create folder `duplicate-thumbnail-highlighter/`.
    - [ ] Initialize git repository (optional but recommended).
- [ ] **Manifest Creation (MV3)**
    - [ ] Create `manifest.json` with:
        - [ ] `manifest_version: 3`
        - [ ] `permissions: ["storage"]`
        - [ ] `host_permissions`: ["*://public.example.com/*", "*://admin.example.com/*"]
        - [ ] content_script matching the above domains.
- [ ] **File Skeleton**
    - [ ] Create `content.js` (entry point).
    - [ ] Create `db.js` (empty module).
    - [ ] Create `hash.js` (empty module).
- [ ] **Smoke Test**
    - [ ] Load unpacked extension in Chrome.
    - [ ] Visit target site.
    - [ ] Verify `console.log` from `content.js` appears.
    - [ ] **Crucial Check**: Verify we can read image data from a canvas. 
        - [ ] In `content.js`, try drawing one of the site's images to a canvas and calling `ctx.getImageData()`.
        - [ ] If this throws a "tainted canvas" error, we need `host_permissions` adjustments or server-side CORS headers (unlikely to change server, so might need "background script" fetching workaround). **Fail early if this is blocked.**

**Definition of Done:**
- [ ] Extension installs without error.
- [ ] Content script runs on the target page.
- [ ] A test image from the site can be drawn to a canvas and `getImageData` returns pixel values without security errors.

---

## Sprint 1 – Visual Highlight Prototype (Fake Data)

**Objective:** specific visual feedback system (Outline + Badge) that is distinct and performant.

**Detailed Tasks:**
- [ ] **Style Logic (`styleForCount`)**
    - [ ] Create function returning CSS values based on count.
    - [ ] **Specs**:
        - Count 1 (New): No outline, no badge.
        - Count 2 (Dup): 2px solid `hsl(120, 90%, 50%)` (Green).
        - Count 5: 3px solid `hsl(60, 90%, 50%)` (Yellow).
        - Count 10+: 4px solid `hsl(0, 90%, 50%)` (Red).
        - Max Count Cap: 50.
- [ ] **Badge Implementation**
    - [ ] Create a `<div>` with `position: absolute`.
    - [ ] Styling: `z-index: 9999`, `pointer-events: none`, `font-weight: bold`.
    - [ ] Ensure it doesn't break the layout of the video card (e.g. check `position: relative` on parent).
- [ ] **Manual Mock Test**
    - [ ] Selector strategy: Identify the stable CSS selector for video thumbnails on the public site.
    - [ ] Loop through all thumbnails and assign random counts (1, 2, 5, 20).
    - [ ] Verify badges appear in the correct corner (e.g. top-right) and don't overlap other UI elements.

**Definition of Done:**
- [ ] The public site loads with the extension active.
- [ ] Every thumbnail has a "fake" count assigned.
- [ ] Thumbnails with count > 1 have a visible colored outline.
- [ ] Thumbnails with count > 1 have a numeric badge correctly positioned.
- [ ] Scrolling the page does not leave "floating" badges (badges move with images).
- [ ] The UI looks "clean" (not breaking site layout).


---

## Sprint 2 – IndexedDB Wiring (Real Counts, Fake Hashes)

**Objective:** Prove out IndexedDB storage, ensuring data persists across reloads and scales to thousands of entries.

**Detailed Tasks:**
- [ ] **Database Layer (`db.js`)**
    - [ ] `openDB()`: standard boilerplate.
    - [ ] `upsertThumbnailRecord(hash, updater)`: Transactional update. 
        - *Critical*: Must handle concurrency if multiple images finish loading at once (though effectively single-threaded in JS event loop, transaction scope matters).
- [ ] **Fake Hash Integration**
    - [ ] Generate stable fake hashes based on `src` URL or just simple counter for testing.
    - [ ] `getThumbnailRecord` -> if exists, increment -> save.
- [ ] **Verification Tooling**
    - [ ] Console command `await printAllCounts()` to dump DB contents for inspection.
    - [ ] `clearAllThumbs()` utility.

**Definition of Done:**
- [ ] Reloading the page *preserves* the incremented counts (Count goes 1 -> 2 -> 3 on resets).
- [ ] Opening a second tab of the same page shows the *current* global counts.
- [ ] Inspecting Application > IndexedDB in DevTools shows rows being added.
- [ ] Can wipe database successfully and reset counts to 0.

---

## Sprint 3 – Real Thumbnail Hashing

**Objective:** Replace fake hashes with real Perceptual Hashes (dHash/pHash) computed from pixel data. **CRITICAL:** Must run background-only to support low-end hardware.

**Detailed Tasks:**
- [ ] **Image Loading Guard**
    - [ ] Wrapper `ensureImageLoaded(img)`: returns Promise.
- [ ] **Canvas Processing & Throttling (Crucial for Low-Spec)**
    - [ ] **Queue System**: Implement `HashQueue` that processes only **1 image every 200ms** (or uses `requestIdleCallback`).
    - [ ] **Yielding**: Ensure the main thread yields completely between hashes.
    - [ ] Create shared offscreen canvas (reuse single canvas).
    - [ ] Context `2d` with `willReadFrequently: true`.
- [ ] **Hashing Algorithm (dHash)**
    - [ ] Convert 32x32 pixels to grayscale.
    - [ ] Compare pixel[i] > pixel[i+1].
    - [ ] Generate binary string / hex string.
- [ ] **Integration**
    - [ ] Pipeline: `Image Element` -> `Queue` -> `Draw` -> `dHash` -> `DB Lookup` -> `Update UI`.

**Definition of Done:**
- [ ] **Zero UI Freeze**: Scrolling must remain smooth while hashing is happening in the background.
- [ ] **Low Impact**: CPU usage should not spike to 100%.
- [ ] Two visually identical thumbnails produce the exact same hash.
- [ ] No "tainted canvas" errors on the real site.


---

## Sprint 4 – Public Site Testing & Performance Checks

**Objective:** Run the extension on the **public site** to verify real-world performance. The goal is "invisible" operation until a duplicate is found.

**Detailed Tasks:**
- [ ] **Load Testing**:
    - [ ] Scroll continuously for 5+ pages of results.
    - [ ] Monitor Memory usage in Chrome Task Manager (ensure no leaks from Canvas).
- [ ] **Throttling/Scheduling**:
    - [ ] Implement `requestIdleCallback` or a simple queue system to hash images one-by-one, preventing UI jank.
    - [ ] If a user scrolls fast, prioritize images currently in viewport (optional, but good practice).
- [ ] **Edge Case Handling**:
    - [ ] What if an image changes src? (MutationObserver might be needed later, for now assume static).
    - [ ] What if network fails? (Graceful fail).

**Definition of Done:**
- [ ] **FPS**: Main UI thread stays above 50fps during scrolling/hashing.
- [ ] **Stability**: No crashes or "Aw Snap" pages after browsing 200+ thumbnails.
- [ ] **Accuracy**: Manually verify visually that "Matched" images are indeed valid duplicates.

---

## Sprint 5 – Admin Portal Integration

**Objective:** Enable the extension on the **admin portal** pages and verify it behaves correctly with real work data.

**Detailed Tasks:**
- [ ] **Permissions Update**: Ensure `manifest.json` host_permissions cover the specific admin URLs.
- [ ] **Selector Tuning**: Admin portal might have different class names for thumbnails.
    - [ ] Create a "Domain-Specific-Selector" map in `content.js` to switch logic based on `window.location`.
- [ ] **Real Data Test**:
    - [ ] Start fresh (Clear DB).
    - [ ] Use the tool for 10 minutes of real work (viewing queues, etc).
    - [ ] Confirm duplicates are being flagged.

**Definition of Done:**
- [ ] Extension automatically activates on Admin pages.
- [ ] Selectors correctly grab all video thumbnails in the admin grid.
- [ ] Highlighting works exactly as tested on Public site.

---

## Sprint 6 – Packaging & Work Machine Install

**Objective:** Package the extension so it can be installed on the work machine that has **no dev tools**, just a browser.

**Detailed Tasks:**
- [ ] **Cleanup**: Remove `console.log` spam. Remove the `Ctrl+Alt+X` clearing shortcut (or hide it behind a specialized Konami code).
- [ ] **Build**: 
    - [ ] Since we are using vanilla JS, "build" just means creating a zip file.
    - [ ] Ensure no `.git` folders or random artifacts are included.
- [ ] **Install Doc**: Write a 3-step text file `INSTALL.txt` to include in the zip: "1. Unzip, 2. Open chrome://extensions, 3. Drag folder in".

**Definition of Done:**
- [ ] The ZIP file can be uncompressed on a clean machine and installed in < 1 minute.
- [ ] No "warnings" or "errors" appear in the Extensions management page upon installation.

---

## Sprint 7 – Quality-of-Life & Nice-to-Haves (Backlog)

**Objective:** polish and advanced features.

- [ ] **Legend / helper overlay** (e.g., a tiny panel explaining colors: green = few repeats, yellow = moderate, red = heavy repeats).
- [ ] **Mini control panel** (popup.html):
    - [ ] "Reset Stats" button.
    - [ ] "Pause Highlighting" toggle.
- [ ] **Hamming-distance tolerance**:
    - [ ] Allow 1-2 bits difference in hash to catch re-compressed JPEGs. (Requires iterating entire DB or using specialized index, might be slow).
