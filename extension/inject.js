// RustyDownloader — Page-level script: hooks fetch/XHR to detect HLS streams
// Detects HLS by reading response bodies for #EXTM3U signature (catches obfuscated CDNs)
(function () {
    'use strict';

    const M3U8_SIGNATURE = '#EXTM3U';
    const TS_EXTINF = '#EXTINF:';
    const HLS_PATTERN = /\.m3u8(\?|#|$)/i;
    const TS_PATTERN = /\.ts(\?|#|$)/i;
    const HLS_URL_HINTS = /(\bm3u8\b|\/playlist\b|\/chunklist|\/hls\/|\/index\.m3u)/i;
    const HLS_CONTENT_TYPES = ['mpegurl', 'mp2t'];

    // DASH manifest detection
    const DASH_PATTERN = /\.mpd(\?|#|$)/i;
    const DASH_CONTENT_TYPES = ['dash+xml'];

    // Direct media content-type prefixes
    const MEDIA_CT_PREFIXES = ['video/', 'audio/'];

    const seen = new Set();
    const w = window.postMessage.bind(window);

    // Notify direct media URL (video/audio src, DASH, etc.)
    function notifyMedia(url) {
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
        if (seen.has(url)) return;
        seen.add(url);
        w({ source: 'rusty-downloader-inject', type: 'media-element-found', url }, '*');
    }

    // ---- Hook HTMLMediaElement.src setter — Catch programmatic src changes (IDM-style) ----
    try {
        const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        if (srcDesc && srcDesc.set) {
            Object.defineProperty(HTMLMediaElement.prototype, 'src', {
                get: srcDesc.get,
                set(value) {
                    if (value && typeof value === 'string' &&
                        !value.startsWith('blob:') && !value.startsWith('data:')) {
                        try { notifyMedia(new URL(value, location.href).href); } catch {}
                    }
                    return srcDesc.set.call(this, value);
                },
                enumerable: srcDesc.enumerable,
                configurable: true,
            });
        }
    } catch {}

    // ---- Hook Element.setAttribute for media src/data (IDM-style) ----
    try {
        const origSetAttr = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function(name, value) {
            if ((name === 'src' || name === 'data') && value && typeof value === 'string') {
                const tag = this.tagName;
                if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE' || tag === 'EMBED') {
                    if (!value.startsWith('blob:') && !value.startsWith('data:')) {
                        try { notifyMedia(new URL(value, location.href).href); } catch {}
                    }
                }
            }
            return origSetAttr.call(this, name, value);
        };
    } catch {}

    function notify(url, type, segmentUrls) {
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
        const key = url + ':' + type;
        if (seen.has(key)) return;
        seen.add(key);
        const msg = { source: 'rusty-downloader-inject', type: 'hls-detected', url, mediaType: type };
        if (segmentUrls && segmentUrls.length > 0) msg.segments = segmentUrls;
        w(msg, '*');
    }

    function resolveUrl(url, base) {
        try { return new URL(url, base || location.href).href; } catch { return url; }
    }

    function isHlsRelated(url) {
        if (!url || typeof url !== 'string') return false;
        return HLS_PATTERN.test(url) || TS_PATTERN.test(url) || HLS_URL_HINTS.test(url);
    }

    // Parse M3U8 content to extract segment URLs
    function parseM3U8Segments(content, baseUrl) {
        const segments = [];
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            // Skip variant playlist references
            if (trimmed.toLowerCase().endsWith('.m3u8') || trimmed.includes('.m3u8?')) continue;
            segments.push(resolveUrl(trimmed, baseUrl));
        }
        return segments;
    }

    // Check if text content is an M3U8 playlist
    function checkM3U8Content(text, responseUrl) {
        if (!text || typeof text !== 'string') return;
        const trimmed = text.trim();
        if (!trimmed.startsWith(M3U8_SIGNATURE)) return;

        // It's an M3U8 playlist!
        const url = responseUrl || '';
        if (url.startsWith('blob:') || url.startsWith('data:')) return;

        // Check if it's a master playlist or media playlist
        if (trimmed.includes('#EXT-X-STREAM-INF')) {
            // Master playlist — extract variant URLs and notify
            const lines = trimmed.split('\n');
            let bestBandwidth = 0;
            let bestUrl = null;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('#EXT-X-STREAM-INF')) {
                    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                    // Next non-comment, non-empty line is the variant URL
                    for (let j = i + 1; j < lines.length; j++) {
                        const vLine = lines[j].trim();
                        if (vLine && !vLine.startsWith('#')) {
                            if (bw >= bestBandwidth) {
                                bestBandwidth = bw;
                                bestUrl = resolveUrl(vLine, url);
                            }
                            break;
                        }
                    }
                }
            }
            if (bestUrl) {
                notify(bestUrl, 'm3u8');
            }
            // Also notify the master playlist itself
            if (url) notify(url, 'm3u8');
        } else if (trimmed.includes(TS_EXTINF) || trimmed.includes('#EXT-X-TARGETDURATION')) {
            // Media playlist — extract segment URLs
            const segments = parseM3U8Segments(trimmed, url);
            notify(url || 'hls-stream', 'm3u8', segments);
        }
    }

    // ---- Hook fetch ----
    const origFetch = window.fetch;
    window.fetch = function (...args) {
        let reqUrl = '';
        try {
            reqUrl = typeof args[0] === 'string' ? args[0]
                : (args[0] instanceof Request ? args[0].url : String(args[0]));
        } catch { }

        // Notify if URL looks HLS-related
        if (reqUrl && isHlsRelated(reqUrl)) {
            notify(resolveUrl(reqUrl), HLS_PATTERN.test(reqUrl) ? 'm3u8' : 'ts');
        }

        return origFetch.apply(this, args).then(response => {
            try {
                const ct = (response.headers.get('content-type') || '').toLowerCase();
                const rurl = response.url || reqUrl;
                const isHlsHint = HLS_CONTENT_TYPES.some(t => ct.includes(t)) || isHlsRelated(rurl);
                const isDashHint = DASH_CONTENT_TYPES.some(t => ct.includes(t)) || DASH_PATTERN.test(rurl);

                // Direct video/audio response — notify URL immediately
                if (MEDIA_CT_PREFIXES.some(p => ct.startsWith(p)) && rurl && !rurl.startsWith('blob:')) {
                    notifyMedia(resolveUrl(rurl));
                }

                // Check content-type for HLS
                if (isHlsHint) {
                    if (rurl && !rurl.startsWith('blob:')) {
                        notify(resolveUrl(rurl), ct.includes('mp2t') ? 'ts' : 'm3u8');
                    }
                }

                // DASH manifest detected
                if (isDashHint && rurl && !rurl.startsWith('blob:')) {
                    notifyMedia(resolveUrl(rurl));
                }

                // Clone+read body for HLS/DASH manifests
                if (response.ok && response.status === 200 && (isHlsHint || isDashHint)) {
                    const clone = response.clone();
                    clone.text().then(text => {
                        if (text && text.trim().startsWith(M3U8_SIGNATURE)) {
                            checkM3U8Content(text, rurl);
                        }
                    }).catch(() => { });
                }
            } catch { }
            return response;
        });
    };

    // ---- Hook XMLHttpRequest ----
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;

    XHR.open = function (method, url, ...rest) {
        this.__ru_url = url;
        return origOpen.apply(this, [method, url, ...rest]);
    };

    XHR.send = function (...args) {
        const url = this.__ru_url;
        if (url && isHlsRelated(String(url))) {
            notify(resolveUrl(String(url)), HLS_PATTERN.test(String(url)) ? 'm3u8' : 'ts');
        }

        this.addEventListener('load', function () {
            try {
                const rurl = this.responseURL || url;

                // Check content-type
                const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
                const isHlsHint = HLS_CONTENT_TYPES.some(t => ct.includes(t)) || isHlsRelated(String(rurl));
                const isDashHint = DASH_CONTENT_TYPES.some(t => ct.includes(t)) || DASH_PATTERN.test(String(rurl));

                // Direct video/audio response — notify URL immediately
                if (MEDIA_CT_PREFIXES.some(p => ct.startsWith(p)) && rurl && !String(rurl).startsWith('blob:')) {
                    notifyMedia(resolveUrl(String(rurl)));
                }

                if (isHlsHint) {
                    if (rurl && !String(rurl).startsWith('blob:')) {
                        notify(resolveUrl(String(rurl)), ct.includes('mp2t') ? 'ts' : 'm3u8');
                    }
                }

                // DASH manifest detected
                if (isDashHint && rurl && !String(rurl).startsWith('blob:')) {
                    notifyMedia(resolveUrl(String(rurl)));
                }

                // Read response body for HLS/DASH manifests
                if (isHlsHint || isDashHint) {
                    let responseText = '';
                    try {
                        if (this.responseType === '' || this.responseType === 'text') {
                            responseText = this.responseText;
                        }
                    } catch { }

                    if (responseText && responseText.trim().startsWith(M3U8_SIGNATURE)) {
                        checkM3U8Content(responseText, String(rurl));
                    }
                }
            } catch { }
        });

        return origSend.apply(this, args);
    };
})();
