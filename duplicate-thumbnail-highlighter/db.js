/**
 * Sprint 2: IndexedDB Helper
 * Handles storage of millions of thumbnail hashes.
 * Attached to window.ThumbDB for access in content.js without modules.
 */

(function () {
    const DB_NAME = 'duplicateThumbsDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'thumbnails';

    let dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'hash' });
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                dbPromise = null;
                reject(req.error);
            };
        });
        return dbPromise;
    }

    async function getThumbnailRecord(hash) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const req = store.get(hash);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            } catch (e) { reject(e); }
        });
    }

    async function upsertThumbnailRecord(hash, pageUrl) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            const getReq = store.get(hash);

            getReq.onsuccess = () => {
                const existing = getReq.result || null;
                const now = Date.now();
                let updated;

                if (existing) {
                    // MIGRATION: Handle legacy records without 'urls'
                    const urls = existing.urls || [];

                    // Deduplication Logic: Only update if URL is new
                    if (!urls.includes(pageUrl)) {
                        console.log(`[DuplicateDetect] New Source URL found for hash ${hash.substring(0, 8)}... :`, pageUrl);
                        urls.push(pageUrl);
                        updated = {
                            ...existing,
                            count: urls.length,
                            urls: urls,
                            lastSeenAt: now
                        };
                    } else {
                        // URL already seen, do not increment count, just return existing
                        // We might update lastSeenAt? Let's treat it as a immutable 'view' to avoid write churn.
                        updated = existing;
                    }
                } else {
                    // New Record
                    updated = {
                        hash: hash,
                        count: 1,
                        urls: [pageUrl],
                        firstSeenAt: now,
                        lastSeenAt: now
                    };
                }

                if (updated !== existing) {
                    const putReq = store.put(updated);
                    putReq.onsuccess = () => resolve(updated);
                    putReq.onerror = () => reject(putReq.error);
                } else {
                    resolve(existing);
                }
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    async function clearAllThumbs() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.clear();
            req.onsuccess = () => {
                console.log("DB Cleared");
                resolve();
            };
            req.onerror = () => reject(req.error);
        });
    }

    async function getAllRecords() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    // Expose to window
    window.ThumbDB = {
        getThumbnailRecord,
        upsertThumbnailRecord,
        clearAllThumbs,
        getAllRecords
    };

    console.log("ThumbDB Module Initialized");

})();
