/**
 * Background script for CORS bypass.
 * Fetches images from any origin and returns them as data URLs.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'FETCH_IMAGE_BLOB') {
        const url = request.url;

        // Fetch via background script (privileged, bypasses CORS)
        fetch(url)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                return response.blob();
            })
            .then(blob => {
                // Convert blob to base64 DataURL to send back to content script
                const reader = new FileReader();
                reader.onloadend = () => {
                    sendResponse({ success: true, dataUrl: reader.result });
                };
                reader.readAsDataURL(blob);
            })
            .catch(error => {
                console.warn('[DuplicateHighlighter] Fetch failed:', url, error.message);
                sendResponse({ success: false, error: error.toString() });
            });

        return true; // Keep message channel open for async response
    }
});
