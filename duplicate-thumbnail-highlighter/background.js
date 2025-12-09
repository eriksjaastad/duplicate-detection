// Allowlist of image CDN hostnames for security
// Only fetch images from known video/image platforms
const ALLOWED_IMAGE_HOSTS = [
    'i.ytimg.com',
    'img.youtube.com',
    'i.vimeocdn.com',
    'image.mux.com',
    'thumbnails.libsyn.com',
    'i.imgur.com',
    'preview.redd.it',
    'external-preview.redd.it',
    'i.redd.it',
    'pbs.twimg.com',
    'cdn.jwplayer.com',
    'static-cdn.jtvnw.net',        // Twitch
    'clips-media-assets2.twitch.tv',
    'i1.sndcdn.com',               // SoundCloud
    'mosaic.scdn.co',              // Spotify
    'i.scdn.co',
];

/**
 * Validates that a URL is safe to fetch.
 * Returns true if the URL is from an allowed image CDN host.
 */
function isAllowedUrl(urlString) {
    try {
        const url = new URL(urlString);
        // Must be HTTPS (or HTTP for local dev)
        if (!['https:', 'http:'].includes(url.protocol)) {
            return false;
        }
        // Check against allowlist
        return ALLOWED_IMAGE_HOSTS.some(host =>
            url.hostname === host || url.hostname.endsWith('.' + host)
        );
    } catch {
        return false;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'FETCH_IMAGE_BLOB') {
        const url = request.url;

        // Security: Validate URL against allowlist
        if (!isAllowedUrl(url)) {
            console.warn('[DuplicateHighlighter] Blocked fetch to non-allowed host:', url);
            sendResponse({ success: false, error: 'URL host not in allowlist' });
            return true;
        }

        // Fetch via background script (privileged)
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
                sendResponse({ success: false, error: error.toString() });
            });

        return true; // Keep message channel open for async response
    }
});
