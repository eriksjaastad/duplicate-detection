/**
 * Perceptual Hashing Module (dHash)
 * Exposed as window.ThumbHash
 *
 * Uses "difference hash" algorithm:
 * 1. Resize image to small square (32x32)
 * 2. Compare adjacent pixel brightness
 * 3. Generate binary hash based on brightness differences
 *
 * This produces a hash that's resilient to:
 * - Image resizing
 * - Minor color adjustments
 * - Compression artifacts
 */
(function () {

    // --- CONFIG ---

    /**
     * Target size for image resizing before hashing.
     * 32x32 provides good balance of accuracy vs performance.
     * Produces a 32x31 = 992 bit hash (248 hex characters).
     */
    const TARGET_SIZE = 32;

    /**
     * Throttle delay between processing images (milliseconds).
     * Prevents overwhelming the browser when many images are queued.
     * 200ms allows ~5 images/second which is sufficient for scrolling.
     */
    const THROTTLE_MS = 200;

    // Reuse a single canvas to save memory
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_SIZE;
    canvas.height = TARGET_SIZE;
    // optimize for pixel reading
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Queue system
    const queue = [];
    let isProcessing = false;

    /**
     * The Public API: Enqueues a request to hash an image URL.
     * Returns a Promise that resolves to the hash string or null.
     */
    function queueHash(url) {
        return new Promise((resolve) => {
            queue.push({ url, resolve });
            processQueue();
        });
    }

    function processQueue() {
        if (isProcessing || queue.length === 0) return;

        isProcessing = true;
        const task = queue.shift();

        // Run the hash task
        computeHashInternal(task.url)
            .then(hash => task.resolve(hash))
            .catch(err => {
                console.warn("Hash failed:", err);
                task.resolve(null);
            })
            .finally(() => {
                // Wait for throttle before next item
                setTimeout(() => {
                    isProcessing = false;
                    processQueue();
                }, THROTTLE_MS);
            });
    }

    /**
     * Steps:
     * 1. Ask background script to fetch blob (CORS bypass).
     * 2. Load blob into Image.
     * 3. Draw to 32x32 canvas.
     * 4. Compute dHash.
     */
    async function computeHashInternal(url) {
        // 1. Fetch via background
        const dataUrl = await fetchImageViaBackground(url);
        if (!dataUrl) return null;

        // 2. Load Image
        const img = await loadImage(dataUrl);

        // 3. Draw Gray (manual grayscale conversion not strictly needed if we just use RGB average, 
        // but let's do simple average during dHash loop or Draw step).
        // For simplicity, we draw color and read RGBA.
        ctx.clearRect(0, 0, TARGET_SIZE, TARGET_SIZE);
        ctx.drawImage(img, 0, 0, TARGET_SIZE, TARGET_SIZE);

        const imgData = ctx.getImageData(0, 0, TARGET_SIZE, TARGET_SIZE);
        const pixels = imgData.data; // RGBA 

        // 4. dHash (Difference Hash)
        // We compare pixel[i] brightness with pixel[i+1] brightness.
        // Row by row.
        let hashStr = "";

        for (let y = 0; y < TARGET_SIZE; y++) {
            for (let x = 0; x < TARGET_SIZE - 1; x++) {
                // Get brightness of pixel A
                const iA = (y * TARGET_SIZE + x) * 4;
                const bA = (pixels[iA] + pixels[iA + 1] + pixels[iA + 2]) / 3;

                // Get brightness of pixel B (right neighbor)
                const iB = (y * TARGET_SIZE + (x + 1)) * 4;
                const bB = (pixels[iB] + pixels[iB + 1] + pixels[iB + 2]) / 3;

                // bit is 1 if Left > Right
                hashStr += (bA > bB) ? "1" : "0";
            }
        }

        // Convert binary string to Hex for shorter storage
        // (Optional, keeps it cleaner in DB)
        return binToHex(hashStr);
    }

    function fetchImageViaBackground(url) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_BLOB', url: url }, (response) => {
                if (chrome.runtime.lastError || !response || !response.success) {
                    resolve(null);
                } else {
                    resolve(response.dataUrl);
                }
            });
        });
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    /**
     * Converts a binary string to hexadecimal.
     * Pads the final chunk if needed to ensure consistent output.
     */
    function binToHex(bin) {
        let hex = '';
        for (let i = 0; i < bin.length; i += 4) {
            // Use slice() instead of deprecated substr()
            let chunk = bin.slice(i, i + 4);
            // Pad with zeros if final chunk is less than 4 bits
            while (chunk.length < 4) {
                chunk += '0';
            }
            hex += parseInt(chunk, 2).toString(16);
        }
        return hex;
    }

    /**
     * Calculate Hamming distance between two hex hash strings.
     * Returns Infinity when lengths differ.
     */
    function hammingDistance(h1, h2) {
        if (!h1 || !h2 || h1.length !== h2.length) return Infinity;

        let distance = 0;
        for (let i = 0; i < h1.length; i++) {
            const xor = (parseInt(h1[i], 16) ^ parseInt(h2[i], 16)) || 0;
            let mask = xor;
            while (mask) {
                distance += mask & 1;
                mask >>= 1;
            }
        }
        return distance;
    }

    // Expose
    window.ThumbHash = {
        queueHash,
        hammingDistance
    };

    console.log("ThumbHash Module Initialized");

})();
