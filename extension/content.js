// RustyDownloader — Content Script: Scan <video>, <audio>, <source>, <embed>, <object> tags
// Inject page-level XHR/fetch hooks for HLS detection
// Uses MutationObserver for dynamically loaded content (IDM-style)

(function () {
    'use strict';

    // ---- Inject page-level script to hook fetch/XHR ----
    try {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        script.onload = function () { this.remove(); };
        (document.head || document.documentElement).appendChild(script);
    } catch (e) {
        console.log('[RustyDownloader] Failed to inject script:', e);
    }

    // ---- Listen for messages from inject.js ----
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'rusty-downloader-inject') return;

        const url = event.data.url;
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;

        if (event.data.type === 'hls-detected' || event.data.type === 'media-element-found') {
            const mediaInfo = {
                url: url,
                filename: filenameFromUrl(url),
                mediaType: 'video',
            };
            if (event.data.segments && event.data.segments.length > 0) {
                mediaInfo.hlsSegments = event.data.segments;
            }
            chrome.runtime.sendMessage({
                type: 'page-media-found',
                media: [mediaInfo],
                pageTitle: document.title,
            });
        }
    });

    // ---- DOM Scanning ----
    const VIDEO_EXTENSIONS = /\.(mp4|webm|flv|mkv|avi|mov|m3u8|ts|mpd)(\?|$)/i;
    const AUDIO_EXTENSIONS = /\.(mp3|flac|wav|aac|ogg|wma|m4a|opus)(\?|$)/i;
    // Also scan for download links (archives, documents, programs)
    const DOWNLOAD_EXTENSIONS = /\.(zip|rar|7z|gz|tar|pdf|doc|docx|xls|xlsx|ppt|pptx|exe|msi|apk|dmg|iso|torrent)(\?|$)/i;

    function classifyUrl(url) {
        if (VIDEO_EXTENSIONS.test(url)) return 'video';
        if (AUDIO_EXTENSIONS.test(url)) return 'audio';
        if (DOWNLOAD_EXTENSIONS.test(url)) return 'document';
        return null;
    }

    function filenameFromUrl(url) {
        try {
            const u = new URL(url);

            // S3/GCS: response-content-disposition query param
            const rcd = u.searchParams.get('response-content-disposition');
            if (rcd) {
                const match = rcd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
                if (match) {
                    const val = match[1].replace(/["']$/g, '');
                    try { return decodeURIComponent(val); } catch { return val; }
                }
            }

            // Explicit filename query parameters (CDN hints — check before pathname)
            for (const key of ['filename', 'file', 'name', 'download', 'fname', 'fn', 'dl', 'title', 'f']) {
                const val = u.searchParams.get(key);
                if (val) {
                    const name = val.split('/').pop().split('\\').pop();
                    if (name) {
                        try { return decodeURIComponent(name); } catch { return name; }
                    }
                }
            }

            // URL pathname
            const pathName = u.pathname.split('/').pop() || '';
            let fromPath;
            try { fromPath = decodeURIComponent(pathName); } catch { fromPath = pathName; }
            if (fromPath && fromPath.includes('.')) return fromPath;

            return fromPath || 'unknown';
        } catch { return 'unknown'; }
    }

    function isValidMediaSrc(src) {
        return src && !src.startsWith('blob:') && !src.startsWith('data:') && !src.startsWith('chrome');
    }

    function scanPage() {
        const found = new Map();

        // Scan <video> and <audio> tags
        document.querySelectorAll('video, audio').forEach(el => {
            const src = el.currentSrc || el.src;
            if (isValidMediaSrc(src) && !found.has(src)) {
                const mediaType = el.tagName === 'VIDEO' ? 'video' : 'audio';
                found.set(src, {
                    url: src,
                    filename: filenameFromUrl(src),
                    mediaType: classifyUrl(src) || mediaType,
                });
            }

            el.querySelectorAll('source').forEach(source => {
                const ssrc = source.src;
                if (isValidMediaSrc(ssrc) && !found.has(ssrc)) {
                    const type = source.type || '';
                    let mt = el.tagName === 'VIDEO' ? 'video' : 'audio';
                    if (type.startsWith('audio')) mt = 'audio';
                    if (type.startsWith('video')) mt = 'video';
                    found.set(ssrc, {
                        url: ssrc,
                        filename: filenameFromUrl(ssrc),
                        mediaType: classifyUrl(ssrc) || mt,
                    });
                }
            });
        });

        // Scan <embed> and <object> tags (IDM does this)
        document.querySelectorAll('embed, object').forEach(el => {
            const src = el.src || el.data;
            if (!isValidMediaSrc(src)) return;
            // Skip text/html and image embeds
            const type = (el.type || '').toLowerCase();
            if (type.startsWith('text/') || type.startsWith('image/')) return;
            if (!found.has(src)) {
                found.set(src, {
                    url: src,
                    filename: filenameFromUrl(src),
                    mediaType: classifyUrl(src) || 'video',
                });
            }
        });

        // Scan standalone <source> tags
        document.querySelectorAll('source').forEach(source => {
            const src = source.src;
            if (isValidMediaSrc(src) && !found.has(src)) {
                const cls = classifyUrl(src);
                if (cls) {
                    found.set(src, {
                        url: src,
                        filename: filenameFromUrl(src),
                        mediaType: cls,
                    });
                }
            }
        });

        // Scan <a> tags with media file links & download attribute
        document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href;
            if (!isValidMediaSrc(href) || found.has(href)) return;
            const cls = classifyUrl(href);
            if (cls) {
                found.set(href, {
                    url: href,
                    filename: a.download || filenameFromUrl(href),
                    mediaType: cls,
                });
            } else if (a.hasAttribute('download')) {
                // <a download="file.pdf"> — explicit download link
                found.set(href, {
                    url: href,
                    filename: a.download || filenameFromUrl(href),
                    mediaType: 'document',
                });
            }
        });

        return Array.from(found.values());
    }

    // Scan DOM when page is ready
    function scanWhenReady() {
        const results = scanPage();
        if (results.length > 0) {
            chrome.runtime.sendMessage({
                type: 'page-media-found',
                media: results,
                pageTitle: document.title,
                pageUrl: location.href,
                pageCookies: document.cookie || '',
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanWhenReady);
    } else {
        scanWhenReady();
    }

    // Re-scan after delay for dynamically loaded content
    setTimeout(scanWhenReady, 3000);

    // ---- ResizeObserver — Detect video elements becoming visible (IDM-style) ----
    const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                const el = entry.target;
                const src = el.currentSrc || el.src;
                if (isValidMediaSrc(src)) {
                    clearTimeout(resizeObserver._timer);
                    resizeObserver._timer = setTimeout(scanWhenReady, 500);
                }
            }
        }
    });

    function observeMediaElement(el) {
        try { resizeObserver.observe(el); } catch {}
    }

    // ---- MutationObserver — Watch for dynamically added media (IDM-style) ----
    const observer = new MutationObserver((mutations) => {
        let foundNew = false;
        for (const mutation of mutations) {
            // Handle attribute changes on media elements (src/data changed dynamically)
            if (mutation.type === 'attributes') {
                const tag = mutation.target.tagName;
                if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE' || tag === 'EMBED' || tag === 'OBJECT') {
                    foundNew = true;
                    break;
                }
                continue;
            }
            // Handle added nodes
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                const tag = node.tagName;
                // Direct media elements or download links
                if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'EMBED' || tag === 'OBJECT' || tag === 'SOURCE') {
                    foundNew = true;
                    if (tag === 'VIDEO' || tag === 'AUDIO') observeMediaElement(node);
                    break;
                }
                if (tag === 'A' && (node.hasAttribute('download') || classifyUrl(node.href))) {
                    foundNew = true;
                    break;
                }
                // Check children
                if (node.querySelector && node.querySelector('video, audio, embed, object, source, a[download], a[href]')) {
                    foundNew = true;
                    node.querySelectorAll('video, audio').forEach(observeMediaElement);
                    break;
                }
            }
            if (foundNew) break;
        }
        if (foundNew) {
            // Debounce: wait a bit for all elements to load
            clearTimeout(observer._timer);
            observer._timer = setTimeout(scanWhenReady, 500);
        }
    });

    // Start observing when DOM is ready
    function startObserver() {
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'data'],
        });
    }

    if (document.body) {
        startObserver();
    } else {
        document.addEventListener('DOMContentLoaded', startObserver);
    }

    // Observe existing video/audio elements for resize/visibility
    document.querySelectorAll('video, audio').forEach(observeMediaElement);

    // ---- Media event listeners — Catch dynamically loaded players (IDM-style) ----
    // Uses capture phase to intercept events from all elements
    let mediaEventTimer;
    for (const eventName of ['play', 'loadeddata', 'loadedmetadata']) {
        document.addEventListener(eventName, (e) => {
            const el = e.target;
            if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
            clearTimeout(mediaEventTimer);
            mediaEventTimer = setTimeout(scanWhenReady, 300);
        }, true);
    }

    // Listen for re-scan requests from popup
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'rescan-page') {
            const results = scanPage();
            sendResponse({ media: results, pageTitle: document.title });
        }
    });
})();
