// RustyDownloader Browser Extension — Background Service Worker
// IDM-style link catching: intercepts network requests at header level,
// detects media/files by MIME type, and sends them to the app.

// Configurable API port (default 7890, persisted in chrome.storage)
let apiPort = 7890;
let apiToken = '';
chrome.storage.local.get({ apiPort: 7890, apiToken: '' }, (data) => {
    apiPort = data.apiPort;
    apiToken = data.apiToken || '';
});
chrome.storage.onChanged.addListener((changes) => {
    if (changes.apiPort) apiPort = changes.apiPort.newValue;
    if (changes.apiToken) apiToken = changes.apiToken.newValue || '';
});
function getApiUrl() { return `http://127.0.0.1:${apiPort}`; }

// =====================================================================
// MIME-to-Extension Map (ported from IDM's Aa object — 100+ types)
// =====================================================================
const MIME_TO_EXT = {
    // ---- Video ----
    'video/mp4': 'MP4', 'video/x-mp4': 'MP4', 'video/x-mpg4': 'MP4', 'video/mpg4': 'MP4',
    'video/webm': 'WEBM', 'video/x-flv': 'FLV', 'video/flv': 'FLV', 'video/x-flash-video': 'FLV',
    'video/avi': 'AVI', 'video/msvideo': 'AVI', 'video/x-msvideo': 'AVI',
    'video/mpeg': 'MPG', 'video/quicktime': 'MOV',
    'video/x-ms-wmv': 'WMV', 'video/x-ms-asf': 'ASF',
    'video/3gpp': '3GP', 'video/3gpp2': '3GP',
    'video/mp2t': 'TS', 'video/f4f': 'F4F',
    'video/mpegurl': 'M3U8', 'video/x-mpegurl': 'M3U8',
    'video/vnd.mpeg.dash.mpd': 'MPD',
    // ---- Audio ----
    'audio/mpeg': 'MP3', 'audio/mp3': 'MP3', 'audio/x-mpeg': 'MP3',
    'audio/mp4': 'M4A', 'audio/mp4a-latm': 'M4A', 'audio/mpeg4-generic': 'M4A',
    'audio/wav': 'WAV', 'audio/x-wav': 'WAV',
    'audio/webm': 'WEBM', 'audio/x-ms-wma': 'WMA',
    'audio/3gpp': '3GP', 'audio/3gpp2': '3GP',
    'audio/mp2t': 'TS', 'audio/mpegurl': 'M3U8', 'audio/x-mpegurl': 'M3U8',
    'audio/ogg': 'OGG', 'audio/flac': 'FLAC', 'audio/aac': 'AAC',
    // ---- HLS / DASH ----
    'application/vnd.apple.mpegurl': 'M3U8', 'application/x-mpegurl': 'M3U8',
    'application/octet-stream-m3u8': 'M3U8',
    'application/dash+xml': 'MPD', 'application/f4m+xml': 'F4M',
    // ---- Archives ----
    'application/zip': 'ZIP', 'application/x-zip': 'ZIP', 'application/x-zip-compressed': 'ZIP',
    'application/x-rar': 'RAR', 'application/x-rar-compressed': 'RAR',
    'application/x-7z-compressed': 'Z7', 'application/x-compress-7z': 'Z7',
    'application/gzip': 'GZ', 'application/x-gzip': 'GZ', 'application/x-gzip-compressed': 'GZ',
    'application/x-tar': 'TAR', 'application/x-gtar': 'TAR',
    'application/x-compressed': 'ARJ', 'application/x-compress': 'Z',
    // ---- Documents ----
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'application/vnd.ms-powerpoint': 'PPT',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
    // ---- Programs / Installers ----
    'application/x-msdos-program': 'EXE', 'application/x-dosexec': 'EXE',
    'application/x-msi': 'MSI', 'application/x-ole-storage': 'MSI',
    'application/x-sdlc': 'EXE',
    // ---- Torrents ----
    'application/x-bittorrent': 'TORRENT', 'application/torrent': 'TORRENT',
    // ---- Disk Images ----
    'application/x-iso9660-image': 'ISO', 'application/x-apple-diskimage': 'DMG',
    // ---- Flash (legacy, but some sites still serve these) ----
    'application/x-shockwave-flash': 'SWF',
    'flv-application/octet-stream': 'FLV',
    // ---- General binary (needs filename/extension check) ----
    'application/octet-stream': null, // decide by extension
};

// Extension → media category
const EXT_CATEGORIES = {
    // Video
    'MP4': 'video', 'WEBM': 'video', 'FLV': 'video', 'AVI': 'video', 'MKV': 'video',
    'MOV': 'video', 'MPG': 'video', 'MPEG': 'video', 'WMV': 'video', 'ASF': 'video',
    '3GP': 'video', 'TS': 'video', 'M4V': 'video', 'F4V': 'video', 'VOB': 'video',
    'M3U8': 'video', 'MPD': 'video', 'F4M': 'video', 'F4F': 'video', 'M4S': 'video',
    // Audio
    'MP3': 'audio', 'M4A': 'audio', 'WAV': 'audio', 'WMA': 'audio', 'AAC': 'audio',
    'OGG': 'audio', 'FLAC': 'audio', 'OPUS': 'audio',
    // Archive
    'ZIP': 'archive', 'RAR': 'archive', 'Z7': 'archive', '7Z': 'archive',
    'GZ': 'archive', 'TAR': 'archive', 'BZ2': 'archive', 'XZ': 'archive', 'ARJ': 'archive',
    // Document
    'PDF': 'document', 'DOC': 'document', 'DOCX': 'document', 'XLS': 'document',
    'XLSX': 'document', 'PPT': 'document', 'PPTX': 'document', 'ODT': 'document',
    'ODS': 'document', 'ODP': 'document',
    // Program
    'EXE': 'program', 'MSI': 'program', 'MSP': 'program', 'DLL': 'program',
    'APK': 'program', 'DMG': 'program', 'DEB': 'program', 'RPM': 'program',
    // Torrent
    'TORRENT': 'torrent', 'BTT': 'torrent',
    // Disk image
    'ISO': 'archive', 'IMG': 'archive',
};

// File extensions that we should always intercept regardless of Content-Type
const KNOWN_EXTENSIONS_RE = /\.(mp4|webm|flv|mkv|avi|mov|mpg|mpeg|wmv|3gp|m4v|ts|m3u8|mpd|mp3|m4a|wav|wma|aac|ogg|flac|opus|zip|rar|7z|gz|tar|bz2|xz|arj|pdf|doc|docx|xls|xlsx|ppt|pptx|exe|msi|apk|dmg|deb|rpm|iso|torrent)(\?|#|$)/i;

// Extensions to SKIP — content types that are page content, not downloads
const SKIP_CONTENT_TYPES = /^(text\/html|text\/css|text\/javascript|application\/javascript|application\/x-javascript|image\/)/;

// HTML page extensions to skip
const SKIP_EXTENSIONS_RE = /^(HTML?|HTM|PHP|ASP|ASPX|JSP|CGI)$/i;

// =====================================================================
// Media Detection State
// =====================================================================
// Map<tabId, { media: Map<key, item>, hlsStreams: Map<baseUrl, hlsInfo>, pageTitle: string }>
const tabData = new Map();

// Map<requestId, { url, method, requestHeaders, tabId, postData, timeStamp }> — request tracking
const requestStore = new Map();
const REQUEST_STORE_MAX = 1000;
const REQUEST_STORE_TTL = 5 * 60 * 1000; // 5 minutes
const HLS_MAX_SEGMENTS = 5000; // cap per stream to prevent memory leak

// Map<finalUrl, { originalUrl, timeStamp }> — track redirects for filename recovery
// CDNs redirect from meaningful URL (with filename) to hash-based CDN URL
const redirectMap = new Map();
const REDIRECT_MAP_MAX = 500;
const REDIRECT_MAP_TTL = 5 * 60 * 1000;

function pruneRedirectMap() {
    if (redirectMap.size <= REDIRECT_MAP_MAX) return;
    const now = Date.now();
    for (const [key, val] of redirectMap) {
        if (now - val.timeStamp > REDIRECT_MAP_TTL) redirectMap.delete(key);
    }
    if (redirectMap.size > REDIRECT_MAP_MAX) {
        const excess = redirectMap.size - REDIRECT_MAP_MAX;
        const iter = redirectMap.keys();
        for (let i = 0; i < excess; i++) redirectMap.delete(iter.next().value);
    }
}

function pruneRequestStore() {
    if (requestStore.size <= REQUEST_STORE_MAX) return;
    const now = Date.now();
    for (const [id, entry] of requestStore) {
        if (now - entry.timeStamp > REQUEST_STORE_TTL) {
            requestStore.delete(id);
        }
    }
    // If still over limit, drop oldest entries
    if (requestStore.size > REQUEST_STORE_MAX) {
        const excess = requestStore.size - REQUEST_STORE_MAX;
        const iter = requestStore.keys();
        for (let i = 0; i < excess; i++) {
            requestStore.delete(iter.next().value);
        }
    }
}

function ensureTabData(tabId) {
    if (!tabData.has(tabId)) {
        tabData.set(tabId, {
            media: new Map(),
            hlsStreams: new Map(),
            pageTitle: '',
        });
    }
    return tabData.get(tabId);
}

// =====================================================================
// Content-Disposition Parsing (ported from IDM's Ic() function)
// =====================================================================
function parseContentDisposition(header) {
    if (!header) return null;
    const parts = header.split(';');
    let filename = null;
    let filenameStar = null;

    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = part.slice(0, eq).trim().toLowerCase();
        let value = part.slice(eq + 1).trim();

        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        if (key === 'filename*') {
            // RFC 5987: encoding'language'value
            const idx = value.indexOf("'");
            if (idx >= 0) {
                const lastIdx = value.lastIndexOf("'");
                value = value.slice(lastIdx + 1);
            }
            try { filenameStar = decodeURIComponent(value); } catch { filenameStar = value; }
        } else if (key === 'filename') {
            try { filename = decodeURIComponent(value); } catch { filename = value; }
        }
    }
    // filename* takes priority (RFC 6266)
    return filenameStar || filename || null;
}

// =====================================================================
// Utility Functions
// =====================================================================
function getExtension(url) {
    try {
        const pathname = new URL(url).pathname;
        const lastSegment = pathname.split('/').pop() || '';
        const parts = lastSegment.split('.');
        if (parts.length < 2) return '';
        // Walk from end, skip purely numeric parts (version suffixes like .1, .2.3)
        for (let i = parts.length - 1; i >= 1; i--) {
            const part = parts[i];
            if (part && !/^\d+$/.test(part)) return part.toUpperCase();
        }
        return '';
    } catch { return ''; }
}

function filenameFromUrl(url) {
    try {
        const u = new URL(url);

        // 1. S3/GCS: response-content-disposition query param (most authoritative)
        const rcd = u.searchParams.get('response-content-disposition');
        if (rcd) {
            const parsed = parseContentDisposition(rcd);
            if (parsed) return parsed;
        }

        // 2. Explicit filename query parameters (CDN hints — check before pathname)
        for (const key of ['filename', 'file', 'name', 'download', 'fname', 'fn', 'dl', 'title', 'f']) {
            const val = u.searchParams.get(key);
            if (val) {
                const name = val.split('/').pop().split('\\').pop();
                if (name) {
                    try { return decodeURIComponent(name); } catch { return name; }
                }
            }
        }

        // 3. URL pathname
        const pathName = u.pathname.split('/').pop() || '';
        let fromPath;
        try { fromPath = decodeURIComponent(pathName); } catch { fromPath = pathName; }
        if (fromPath && fromPath.includes('.')) return fromPath;

        return fromPath || 'media_file';
    } catch { return 'media_file'; }
}

function getUrlBasePath(url) {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/');
        parts.pop();
        return u.origin + parts.join('/') + '/';
    } catch { return url; }
}

function sanitizeFilename(title) {
    return title
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 120);
}

function getResponseHeader(headers, name) {
    if (!headers) return null;
    const lower = name.toLowerCase();
    for (const h of headers) {
        if (h.name.toLowerCase() === lower) return h.value;
    }
    return null;
}

function classifyExtension(ext) {
    if (!ext) return null;
    return EXT_CATEGORIES[ext.toUpperCase()] || null;
}

function hlsPathsMatch(a, b) {
    // Ensure trailing slash comparison to avoid /stream1/ matching /stream10/
    const na = a.endsWith('/') ? a : a + '/';
    const nb = b.endsWith('/') ? b : b + '/';
    return na.startsWith(nb) || nb.startsWith(na);
}

// =====================================================================
// Add Media to Tab (with HLS grouping)
// =====================================================================
function addMediaToTab(tabId, mediaItem) {
    if (!mediaItem.url || mediaItem.url.startsWith('blob:') ||
        mediaItem.url.startsWith('data:') || mediaItem.url.startsWith('chrome')) {
        return;
    }

    const td = ensureTabData(tabId);
    const ext = mediaItem.type?.toUpperCase() || getExtension(mediaItem.url);

    // ---- HLS grouping ----
    if (ext === 'TS') {
        const basePath = getUrlBasePath(mediaItem.url);
        let streamKey = null;
        for (const [key] of td.hlsStreams) {
            if (hlsPathsMatch(basePath, key)) {
                streamKey = key;
                break;
            }
        }
        if (!streamKey) {
            streamKey = basePath;
            td.hlsStreams.set(basePath, {
                m3u8Url: null, basePath, segmentUrls: new Set(),
                segmentCount: 0, totalSize: 0, firstSeen: Date.now(),
            });
        }
        const stream = td.hlsStreams.get(streamKey);
        if (!stream.segmentUrls.has(mediaItem.url) && stream.segmentUrls.size < HLS_MAX_SEGMENTS) {
            stream.segmentUrls.add(mediaItem.url);
            stream.segmentCount++;
            stream.totalSize += (mediaItem.size || 0);
        }
        return;
    }

    if (ext === 'M3U8') {
        const basePath = getUrlBasePath(mediaItem.url);
        let existingKey = null;
        for (const [key] of td.hlsStreams) {
            if (hlsPathsMatch(basePath, key)) {
                existingKey = key;
                break;
            }
        }
        if (existingKey) {
            const stream = td.hlsStreams.get(existingKey);
            if (!stream.m3u8Url || mediaItem.url.length > stream.m3u8Url.length) {
                stream.m3u8Url = mediaItem.url;
            }
        } else {
            td.hlsStreams.set(basePath, {
                m3u8Url: mediaItem.url, basePath, segmentUrls: new Set(),
                segmentCount: 0, totalSize: 0, firstSeen: Date.now(),
            });
        }
        return;
    }

    // ---- Regular media ----
    if (!td.media.has(mediaItem.url)) {
        td.media.set(mediaItem.url, mediaItem);
    }
}

function getMediaListForTab(tabId) {
    const td = tabData.get(tabId);
    if (!td) return [];

    const items = [];
    for (const item of td.media.values()) items.push(item);

    for (const [, stream] of td.hlsStreams) {
        if (stream.segmentCount === 0 && !stream.m3u8Url) continue;
        const pageTitle = td.pageTitle || '';
        const cleanTitle = sanitizeFilename(pageTitle);
        const displayName = cleanTitle ? `${cleanTitle}.ts` : 'HLS Stream.ts';

        items.push({
            url: stream.m3u8Url || stream.basePath,
            filename: displayName,
            size: stream.totalSize,
            type: 'm3u8',
            mediaType: 'video',
            isHls: true,
            segmentCount: stream.segmentCount,
            segmentUrls: [...stream.segmentUrls],
            hasM3u8: !!stream.m3u8Url,
        });
    }
    return items;
}

// =====================================================================
// Network Request Interception — IDM Style
// =====================================================================

// 1. onBeforeRequest — Track requests, catch POST body, flag media URLs
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0) return;
        const url = details.url;
        if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('chrome')) return;

        // Store request info for later use in onHeadersReceived
        const entry = {
            url,
            method: details.method,
            tabId: details.tabId,
            type: details.type,
            timeStamp: details.timeStamp,
        };

        // Capture POST body (like IDM does for video player requests)
        if (details.method === 'POST' && details.requestBody) {
            entry.postData = details.requestBody;
        }

        requestStore.set(details.requestId, entry);
        pruneRequestStore();
    },
    { urls: ['<all_urls>'] },
    ['requestBody']
);

// 2. onBeforeSendHeaders — Capture request headers (cookies, referer, user-agent)
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const entry = requestStore.get(details.requestId);
        if (entry) {
            entry.requestHeaders = details.requestHeaders;
        }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders']
);

// 3. onHeadersReceived — The main detection point (like IDM's Ub/Gc functions)
// This fires when we have response headers but BEFORE the response body downloads.
chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        if (details.tabId < 0) return;
        const url = details.url;
        if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('chrome')) return;

        // Skip non-downloadable status codes
        const status = details.statusCode;
        if (status !== 200 && status !== 206 && status !== 304) return;

        // Skip sub_frame navigations that are HTML pages (not downloads)
        const headers = details.responseHeaders;
        const contentType = (getResponseHeader(headers, 'content-type') || '').toLowerCase();
        const contentDisposition = getResponseHeader(headers, 'content-disposition') || '';
        const contentLength = parseInt(getResponseHeader(headers, 'content-length') || '0', 10);

        // Parse content type (strip parameters like charset)
        const mimeType = contentType.split(';')[0].trim();

        // Skip HTML pages and stylesheets/scripts (unless Content-Disposition says attachment)
        const isAttachment = contentDisposition.toLowerCase().includes('attachment');
        if (!isAttachment && SKIP_CONTENT_TYPES.test(mimeType)) return;

        // ---- Determine file extension ----
        // Priority: Content-Disposition filename > MIME mapping > URL extension
        let detectedExt = '';
        let detectedFilename = '';

        // 1. Content-Disposition (most reliable for filename)
        const cdFilename = parseContentDisposition(contentDisposition);
        if (cdFilename) {
            detectedFilename = cdFilename;
            const cdExt = cdFilename.split('.').pop()?.toUpperCase() || '';
            if (cdExt && !SKIP_EXTENSIONS_RE.test(cdExt)) {
                detectedExt = cdExt;
            }
        }

        // 2. MIME type mapping
        if (!detectedExt && mimeType) {
            const mapped = MIME_TO_EXT[mimeType];
            if (mapped) {
                detectedExt = mapped;
            } else if (mimeType === 'application/octet-stream') {
                // For octet-stream, fall through to URL extension
            }
        }

        // 3. URL extension (also try original URL from redirect chain)
        let urlExt = getExtension(url);
        if (!urlExt) {
            const reqEntry = requestStore.get(details.requestId);
            if (reqEntry?.originalUrl) urlExt = getExtension(reqEntry.originalUrl);
        }
        if (!detectedExt && urlExt && !SKIP_EXTENSIONS_RE.test(urlExt)) {
            detectedExt = urlExt.toUpperCase();
        }

        // If we still don't have an extension at this point:
        // Check for octet-stream attachments (IDM catches these too)
        if (!detectedExt && isAttachment && contentLength > 0) {
            // It's an attachment with no recognizable extension — still a download
            detectedExt = 'BIN';
        }

        // After all checks, if no extension or it's a skipped type, return
        if (!detectedExt) return;
        if (SKIP_EXTENSIONS_RE.test(detectedExt)) return;

        // ---- Determine media category ----
        const mediaCategory = classifyExtension(detectedExt) || (isAttachment ? 'document' : null);
        if (!mediaCategory) return;

        // ---- Build filename ----
        if (!detectedFilename) {
            detectedFilename = filenameFromUrl(url);
        }

        // ---- Capture request headers for the app ----
        const entry = requestStore.get(details.requestId);

        // Try original URL from redirect chain for better filename (IDM-style)
        // CDN final URLs are often hashes like /a1b2c3d4, original URL has real name
        if ((!detectedFilename || detectedFilename === 'media_file') && entry?.originalUrl) {
            const origName = filenameFromUrl(entry.originalUrl);
            if (origName && origName !== 'media_file') {
                detectedFilename = origName;
            }
        }
        let cookies = '';
        let referer = '';
        let userAgent = '';
        if (entry && entry.requestHeaders) {
            for (const h of entry.requestHeaders) {
                const name = h.name.toLowerCase();
                if (name === 'cookie') cookies = h.value;
                else if (name === 'referer') referer = h.value;
                else if (name === 'user-agent') userAgent = h.value;
            }
        }

        // ---- Add to detected media ----
        addMediaToTab(details.tabId, {
            url,
            filename: detectedFilename,
            size: contentLength,
            type: detectedExt.toLowerCase(),
            mediaType: mediaCategory,
            cookies,
            referer,
            userAgent,
            mimeType,
        });
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
);

// 4. Clean up request store when request completes or errors
chrome.webRequest.onCompleted.addListener(
    (details) => { requestStore.delete(details.requestId); },
    { urls: ['<all_urls>'] }
);
chrome.webRequest.onErrorOccurred.addListener(
    (details) => { requestStore.delete(details.requestId); },
    { urls: ['<all_urls>'] }
);

// 5. onBeforeRedirect — Track redirect chains for filename recovery (IDM-style)
// CDNs often redirect from a meaningful URL (with filename) to a hash-based URL
chrome.webRequest.onBeforeRedirect.addListener(
    (details) => {
        const entry = requestStore.get(details.requestId);
        if (entry) {
            if (!entry.originalUrl) {
                entry.originalUrl = entry.url;
            }
            // Store in redirect map for downloads.onCreated lookup (no requestId there)
            redirectMap.set(details.redirectUrl, {
                originalUrl: entry.originalUrl,
                timeStamp: Date.now(),
            });
            pruneRedirectMap();
        }
    },
    { urls: ['<all_urls>'] }
);

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
    tabData.delete(tabId);
});

// Clean up when tab navigates to new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
        tabData.delete(tabId);
    }
    if (changeInfo.title || (tab && tab.title)) {
        const td = ensureTabData(tabId);
        td.pageTitle = changeInfo.title || tab.title || '';
    }
});

// =====================================================================
// Download Interception (IDM-style: cancel browser download, send to app)
// =====================================================================
chrome.downloads.onCreated.addListener(async (downloadItem) => {
    const isRunning = await checkAppStatus();
    if (!isRunning) return;

    const { interceptDownloads } = await chrome.storage.local.get({ interceptDownloads: false });
    if (!interceptDownloads) return;

    // Use finalUrl (post-redirect) when available — CDNs redirect to the actual file
    const url = downloadItem.finalUrl || downloadItem.url;
    if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome')) return;

    // Try to get the best filename (priority order):
    // 1. downloadItem.filename (local path from browser — may be empty at onCreated time)
    // 2. tabData lookup (Content-Disposition parsed in onHeadersReceived)
    // 3. filenameFromUrl on finalUrl, then original url
    let filename = downloadItem.filename || '';
    // downloadItem.filename includes path – get just the name
    if (filename.includes('/')) filename = filename.split('/').pop();
    if (filename.includes('\\')) filename = filename.split('\\').pop();

    if (!filename) {
        // Search tabData — onHeadersReceived already parsed Content-Disposition
        for (const [, td] of tabData) {
            const item = td.media.get(url) || td.media.get(downloadItem.url);
            if (item && item.filename && item.filename !== 'media_file') {
                filename = item.filename;
                break;
            }
        }
    }

    if (!filename) filename = filenameFromUrl(url);
    // If finalUrl gave a bad name, try original url too
    if ((!filename || filename === 'media_file') && downloadItem.finalUrl) {
        const fromOriginal = filenameFromUrl(downloadItem.url);
        if (fromOriginal && fromOriginal !== 'media_file') {
            filename = fromOriginal;
        }
    }

    // Try redirect chain's original URL (catches multi-hop CDN redirects)
    if (!filename || filename === 'media_file') {
        const redir = redirectMap.get(url) || redirectMap.get(downloadItem.finalUrl) || redirectMap.get(downloadItem.url);
        if (redir) {
            const fromRedir = filenameFromUrl(redir.originalUrl);
            if (fromRedir && fromRedir !== 'media_file') {
                filename = fromRedir;
            }
        }
    }

    // Extract browser cookies for the download URL so the app can use them
    // for authenticated downloads (e.g. private Google Drive files)
    let cookies = '';
    try {
        const allCookies = await chrome.cookies.getAll({ url });
        cookies = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch {}

    chrome.downloads.cancel(downloadItem.id, () => {
        chrome.downloads.erase({ id: downloadItem.id });
        sendToApp(url, filename, { cookies });
    });
});

// =====================================================================
// Fetch media sizes in background
// =====================================================================
async function fetchMediaSize(url) {
    try {
        const resp = await fetch(url, { method: 'HEAD' });
        const cl = resp.headers.get('content-length');
        return cl ? parseInt(cl, 10) : 0;
    } catch { return 0; }
}

// =====================================================================
// Context Menu
// =====================================================================
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'download-with-rusty',
        title: 'Download with RustyDownloader',
        contexts: ['link'],
    });
    chrome.contextMenus.create({
        id: 'download-image-with-rusty',
        title: 'Download image with RustyDownloader',
        contexts: ['image'],
    });
    chrome.contextMenus.create({
        id: 'download-video-with-rusty',
        title: 'Download video/audio with RustyDownloader',
        contexts: ['video', 'audio'],
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    let url = '';
    switch (info.menuItemId) {
        case 'download-with-rusty': url = info.linkUrl; break;
        case 'download-image-with-rusty': url = info.srcUrl; break;
        case 'download-video-with-rusty': url = info.srcUrl; break;
    }

    if (url) {
        let filename = '';
        try {
            const urlObj = new URL(url);
            filename = urlObj.pathname.split('/').pop()?.split('?')[0] || '';
        } catch { }

        // Extract cookies for authenticated downloads
        let cookies = '';
        try {
            const allCookies = await chrome.cookies.getAll({ url });
            cookies = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
        } catch {}

        // Use tab URL as referer — many CDNs require this
        const referer = tab?.url || '';

        sendToApp(url, filename, { cookies, referer });
    }
});

// =====================================================================
// API Communication
// =====================================================================
async function sendToApp(url, filename, extra) {
    try {
        const body = { url, filename };
        if (extra) {
            if (extra.cookies) body.cookies = extra.cookies;
            if (extra.referer) body.referer = extra.referer;
            if (extra.userAgent) body.userAgent = extra.userAgent;
        }
        const headers = { 'Content-Type': 'application/json' };
        if (apiToken) headers['X-Auth-Token'] = apiToken;
        const response = await fetch(`${getApiUrl()}/download`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (response.ok) {
            chrome.action.setBadgeText({ text: '✓' });
            chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
            setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
            return true;
        } else {
            showError('Failed to send download to app');
            return false;
        }
    } catch {
        showError('RustyDownloader is not running');
        return false;
    }
}

async function sendHlsToApp(url, filename, segments) {
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (apiToken) headers['X-Auth-Token'] = apiToken;
        const response = await fetch(`${getApiUrl()}/download-hls`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ url, filename, segments: segments || [] }),
        });
        if (response.ok) {
            chrome.action.setBadgeText({ text: '✓' });
            chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
            setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
            return true;
        } else {
            showError('Failed to send HLS download to app');
            return false;
        }
    } catch {
        showError('RustyDownloader is not running');
        return false;
    }
}

async function checkAppStatus() {
    try {
        const response = await fetch(`${getApiUrl()}/ping`, { method: 'GET' });
        return response.ok;
    } catch { return false; }
}

function showError(message) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
}

// =====================================================================
// Message Handler
// =====================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'check-status') {
        checkAppStatus().then(status => sendResponse({ running: status }));
        return true;
    }

    if (msg.type === 'send-download') {
        sendToApp(msg.url, msg.filename || '', msg.extra).then(ok => sendResponse({ ok }));
        return true;
    }

    if (msg.type === 'send-hls-download') {
        sendHlsToApp(msg.url, msg.filename || '', msg.segments || []).then(ok => sendResponse({ ok }));
        return true;
    }

    if (msg.type === 'get-intercept') {
        chrome.storage.local.get({ interceptDownloads: false }, (data) => {
            sendResponse(data);
        });
        return true;
    }

    if (msg.type === 'set-intercept') {
        chrome.storage.local.set({ interceptDownloads: msg.value }, () => {
            sendResponse({ ok: true });
        });
        return true;
    }

    if (msg.type === 'get-port') {
        chrome.storage.local.get({ apiPort: 7890 }, (data) => {
            sendResponse({ port: data.apiPort });
        });
        return true;
    }

    if (msg.type === 'set-port') {
        const port = parseInt(msg.value, 10);
        if (port >= 1 && port <= 65535) {
            apiPort = port;
            chrome.storage.local.set({ apiPort: port }, () => {
                sendResponse({ ok: true });
            });
        } else {
            sendResponse({ ok: false });
        }
        return true;
    }

    if (msg.type === 'get-token') {
        chrome.storage.local.get({ apiToken: '' }, (data) => {
            sendResponse({ token: data.apiToken });
        });
        return true;
    }

    if (msg.type === 'set-token') {
        apiToken = msg.value || '';
        chrome.storage.local.set({ apiToken: apiToken }, () => {
            sendResponse({ ok: true });
        });
        return true;
    }

    // Content script found media on page
    if (msg.type === 'page-media-found') {
        const tabId = sender.tab?.id;
        if (tabId) {
            if (msg.pageTitle) {
                const td = ensureTabData(tabId);
                td.pageTitle = msg.pageTitle;
            }

            // Capture page-level cookies and referer from content script
            const pageCookies = msg.pageCookies || '';
            const pageReferer = msg.pageUrl || sender.tab?.url || '';

            if (msg.media) {
                msg.media.forEach(item => {
                    const ext = getExtension(item.url);
                    const type = ext || (item.mediaType === 'video' ? 'm3u8' : ext);

                    addMediaToTab(tabId, {
                        url: item.url,
                        filename: item.filename || filenameFromUrl(item.url),
                        size: 0,
                        type: type,
                        mediaType: item.mediaType || classifyExtension(ext) || 'video',
                        cookies: pageCookies,
                        referer: pageReferer,
                    });

                    if (item.hlsSegments && item.hlsSegments.length > 0) {
                        const td = ensureTabData(tabId);
                        for (const [key, stream] of td.hlsStreams) {
                            if (stream.m3u8Url === item.url || item.url.includes(key) || key.includes(getUrlBasePath(item.url))) {
                                for (const segUrl of item.hlsSegments) {
                                    if (!stream.segmentUrls.has(segUrl)) {
                                        stream.segmentUrls.add(segUrl);
                                        stream.segmentCount++;
                                    }
                                }
                                break;
                            }
                        }
                    }
                });

                const td = tabData.get(tabId);
                if (td) {
                    for (const [url, item] of td.media) {
                        if (item.size === 0) {
                            fetchMediaSize(url).then(size => { item.size = size; });
                        }
                    }
                }
            }
        }
        return false;
    }

    // Popup requests detected media list
    if (msg.type === 'get-detected-media') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs[0]?.id;
            if (!tabId) { sendResponse({ media: [] }); return; }

            const td = ensureTabData(tabId);
            if (tabs[0].title) td.pageTitle = tabs[0].title;

            const items = getMediaListForTab(tabId);
            sendResponse({ media: items });
        });
        return true;
    }

    // Popup requests re-scan
    if (msg.type === 'rescan-media') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs[0]?.id;
            if (!tabId) { sendResponse({ media: [] }); return; }

            const td = ensureTabData(tabId);
            if (tabs[0].title) td.pageTitle = tabs[0].title;

            chrome.tabs.sendMessage(tabId, { type: 'rescan-page' }, (response) => {
                if (response && response.media) {
                    if (response.pageTitle) td.pageTitle = response.pageTitle;

                    response.media.forEach(item => {
                        addMediaToTab(tabId, {
                            url: item.url,
                            filename: item.filename || filenameFromUrl(item.url),
                            size: 0,
                            type: getExtension(item.url),
                            mediaType: item.mediaType || classifyExtension(getExtension(item.url)) || 'video',
                        });
                    });

                    const promises = [];
                    for (const [url, item] of td.media) {
                        if (item.size === 0) {
                            promises.push(fetchMediaSize(url).then(size => { item.size = size; }));
                        }
                    }
                    Promise.all(promises).then(() => {
                        sendResponse({ media: getMediaListForTab(tabId) });
                    });
                } else {
                    sendResponse({ media: getMediaListForTab(tabId) });
                }
            });
        });
        return true;
    }
});
