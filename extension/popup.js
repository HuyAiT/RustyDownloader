// RustyDownloader Extension — Popup Logic

// ---- Elements ----
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const urlInput = document.getElementById('url-input');
const btnDownload = document.getElementById('btn-download');
const toast = document.getElementById('toast');
const toggleIntercept = document.getElementById('toggle-intercept');

// Tabs
const tabBtns = document.querySelectorAll('.tab-btn');
const tabQuick = document.getElementById('tab-quick');
const tabScanner = document.getElementById('tab-scanner');

// Scanner
const mediaList = document.getElementById('media-list');
const mediaCountBadge = document.getElementById('media-count');
const scannerEmpty = document.getElementById('scanner-empty');
const scanningSpinner = document.getElementById('scanning-spinner');
const filterBtns = document.querySelectorAll('.filter-btn');
const btnSort = document.getElementById('btn-sort');
const sortDropdown = document.getElementById('sort-dropdown');
const sortOptions = document.querySelectorAll('.sort-option');
const btnRescan = document.getElementById('btn-rescan');
const btnDownloadAll = document.getElementById('btn-download-all');

// ---- State ----
let appRunning = false;
let detectedMedia = [];
let currentFilter = 'all';
let currentSort = 'name';
let sortDirection = 1; // 1 = asc, -1 = desc

// ---- Tab Switching ----
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const tab = btn.dataset.tab;
        tabQuick.classList.toggle('active', tab === 'quick');
        tabScanner.classList.toggle('active', tab === 'scanner');

        if (tab === 'scanner') {
            loadMedia();
        }
    });
});

// ---- App Status ----
async function checkStatus() {
    chrome.runtime.sendMessage({ type: 'check-status' }, (response) => {
        appRunning = response && response.running;
        if (appRunning) {
            statusDot.className = 'status-dot online';
            statusText.className = 'status-label online';
            statusText.textContent = 'Connected';
            btnDownload.disabled = false;
        } else {
            statusDot.className = 'status-dot offline';
            statusText.className = 'status-label offline';
            statusText.textContent = 'Offline';
            btnDownload.disabled = true;
        }
    });
}

// ---- Intercept Toggle ----
chrome.runtime.sendMessage({ type: 'get-intercept' }, (response) => {
    if (response) {
        toggleIntercept.checked = response.interceptDownloads || false;
    }
});

toggleIntercept.addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'set-intercept',
        value: toggleIntercept.checked,
    });
});

// ---- Quick Download ----
btnDownload.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) {
        urlInput.focus();
        return;
    }

    if (!url.startsWith('http')) {
        showToast('Please enter a valid URL', 'error');
        return;
    }

    chrome.runtime.sendMessage({ type: 'send-download', url, filename: '' }, (response) => {
        if (response && response.ok) {
            showToast('Sent to RustyDownloader!', 'success');
            urlInput.value = '';
        } else {
            showToast('Failed to send', 'error');
        }
    });
});

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnDownload.click();
});

function showToast(message, type) {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    setTimeout(() => {
        toast.className = 'toast';
    }, 3000);
}

// ---- Media Scanner ----
function loadMedia() {
    scanningSpinner.classList.add('active');
    scannerEmpty.style.display = 'none';
    mediaList.innerHTML = '';

    chrome.runtime.sendMessage({ type: 'get-detected-media' }, (response) => {
        scanningSpinner.classList.remove('active');
        if (response && response.media) {
            detectedMedia = response.media;
            updateMediaCount();
            renderMediaList();
        } else {
            detectedMedia = [];
            updateMediaCount();
            scannerEmpty.style.display = 'flex';
        }
    });
}

function updateMediaCount() {
    const count = detectedMedia.length;
    if (count > 0) {
        mediaCountBadge.textContent = count;
        mediaCountBadge.style.display = 'inline';
    } else {
        mediaCountBadge.style.display = 'none';
    }
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getFilteredMedia() {
    let items = [...detectedMedia];

    // Filter
    if (currentFilter !== 'all') {
        items = items.filter(m => m.mediaType === currentFilter);
    }

    // Sort
    items.sort((a, b) => {
        let cmp = 0;
        switch (currentSort) {
            case 'name':
                cmp = (a.filename || '').localeCompare(b.filename || '');
                break;
            case 'size':
                cmp = (a.size || 0) - (b.size || 0);
                break;
            case 'type':
                cmp = (a.type || '').localeCompare(b.type || '');
                break;
        }
        return cmp * sortDirection;
    });

    return items;
}

function renderMediaList() {
    const items = getFilteredMedia();
    mediaList.innerHTML = '';

    if (items.length === 0) {
        scannerEmpty.style.display = 'flex';
        btnDownloadAll.classList.remove('visible');
        return;
    }

    scannerEmpty.style.display = 'none';
    btnDownloadAll.classList.toggle('visible', items.length > 1);

    items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'media-item';

        const isHls = item.isHls || item.type === 'm3u8' || item.type === 'mpd';
        const cat = item.mediaType || 'video';

        // Icon & styling per category
        let icon = '🎬', iconClass = 'video', badgeClass = 'video';
        switch (cat) {
            case 'audio': icon = '🎵'; iconClass = 'audio'; badgeClass = 'audio'; break;
            case 'archive': icon = '📦'; iconClass = 'archive'; badgeClass = 'archive'; break;
            case 'document': icon = '📄'; iconClass = 'document'; badgeClass = 'document'; break;
            case 'program': icon = '💿'; iconClass = 'program'; badgeClass = 'program'; break;
            case 'torrent': icon = '🔗'; iconClass = 'torrent'; badgeClass = 'torrent'; break;
        }
        if (isHls) badgeClass = 'hls';
        const badgeText = isHls ? 'HLS' : (item.type || 'media').toUpperCase();

        // Size info: for HLS show segment count too
        let sizeInfo = formatBytes(item.size);
        if (isHls && item.segmentCount) {
            sizeInfo = `${item.segmentCount} segments` + (item.size ? ` · ${formatBytes(item.size)}` : '');
        }

        // Build DOM safely instead of innerHTML
        const iconDiv = document.createElement('div');
        iconDiv.className = `media-icon ${iconClass}`;
        iconDiv.textContent = icon;

        const nameDiv = document.createElement('div');
        nameDiv.className = 'media-name';
        nameDiv.title = item.url || '';
        nameDiv.textContent = item.filename || 'Unknown';

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'media-size';
        sizeSpan.textContent = sizeInfo;

        const badgeSpan = document.createElement('span');
        badgeSpan.className = `media-type-badge ${badgeClass}`;
        badgeSpan.textContent = badgeText;

        const metaDiv = document.createElement('div');
        metaDiv.className = 'media-meta';
        metaDiv.appendChild(sizeSpan);
        metaDiv.appendChild(badgeSpan);

        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'media-details';
        detailsDiv.appendChild(nameDiv);
        detailsDiv.appendChild(metaDiv);

        const dlBtn = document.createElement('button');
        dlBtn.className = 'media-dl-btn';
        dlBtn.title = 'Download';
        dlBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>`;

        el.appendChild(iconDiv);
        el.appendChild(detailsDiv);
        el.appendChild(dlBtn);
        dlBtn.addEventListener('click', () => {
            if (!appRunning) {
                showToast('RustyDownloader is not running', 'error');
                return;
            }

            if (isHls) {
                chrome.runtime.sendMessage({
                    type: 'send-hls-download',
                    url: item.url,
                    filename: item.filename || 'stream.ts',
                    segments: item.segmentUrls || [],
                }, (response) => {
                    if (response && response.ok) {
                        showToast('HLS download sent!', 'success');
                    } else {
                        showToast('Failed to send', 'error');
                    }
                });
            } else {
                chrome.runtime.sendMessage({
                    type: 'send-download',
                    url: item.url,
                    filename: item.filename || '',
                    extra: { cookies: item.cookies || '', referer: item.referer || '' },
                }, (response) => {
                    if (response && response.ok) {
                        showToast('Download sent!', 'success');
                    } else {
                        showToast('Failed to send', 'error');
                    }
                });
            }
        });

        mediaList.appendChild(el);
    });
}

// ---- Filter ----
filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderMediaList();
    });
});

// ---- Sort ----
btnSort.addEventListener('click', (e) => {
    e.stopPropagation();
    sortDropdown.classList.toggle('open');
});

document.addEventListener('click', () => {
    sortDropdown.classList.remove('open');
});

sortOptions.forEach(opt => {
    opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const sort = opt.dataset.sort;

        if (currentSort === sort) {
            // Toggle direction
            sortDirection *= -1;
        } else {
            currentSort = sort;
            sortDirection = 1;
        }

        // Update UI
        sortOptions.forEach(o => {
            o.classList.remove('active');
            o.querySelector('.sort-arrow').textContent = '↑';
        });
        opt.classList.add('active');
        opt.querySelector('.sort-arrow').textContent = sortDirection === 1 ? '↑' : '↓';

        renderMediaList();
        sortDropdown.classList.remove('open');
    });
});

// ---- Re-scan ----
btnRescan.addEventListener('click', () => {
    scanningSpinner.classList.add('active');
    scannerEmpty.style.display = 'none';
    mediaList.innerHTML = '';

    chrome.runtime.sendMessage({ type: 'rescan-media' }, (response) => {
        scanningSpinner.classList.remove('active');
        if (response && response.media) {
            detectedMedia = response.media;
            updateMediaCount();
            renderMediaList();
        } else {
            renderMediaList();
        }
    });
});

// ---- Download All ----
btnDownloadAll.addEventListener('click', () => {
    if (!appRunning) {
        showToast('RustyDownloader is not running', 'error');
        return;
    }

    const items = getFilteredMedia();
    if (items.length === 0) return;

    let sent = 0;
    items.forEach(item => {
        const isHls = item.isHls || item.type === 'm3u8' || item.type === 'mpd';
        const msgType = isHls ? 'send-hls-download' : 'send-download';
        const msg = {
            type: msgType,
            url: item.url,
            filename: item.filename || '',
        };
        if (isHls) msg.segments = item.segmentUrls || [];

        chrome.runtime.sendMessage(msg, () => {
            sent++;
            if (sent === items.length) {
                showToast(`Sent ${items.length} downloads!`, 'success');
            }
        });
    });
});

// ---- Port Config ----
const portInput = document.getElementById('port-input');

chrome.runtime.sendMessage({ type: 'get-port' }, (response) => {
    if (response && response.port) {
        portInput.value = response.port;
    }
});

portInput.addEventListener('change', () => {
    const port = parseInt(portInput.value, 10);
    if (port >= 1 && port <= 65535) {
        chrome.runtime.sendMessage({ type: 'set-port', value: port });
    } else {
        portInput.value = 7890;
    }
});

// ---- API Token Config ----
const tokenInput = document.getElementById('token-input');

chrome.runtime.sendMessage({ type: 'get-token' }, (response) => {
    if (response && response.token) {
        tokenInput.value = response.token;
    }
});

tokenInput.addEventListener('change', () => {
    const token = tokenInput.value.trim();
    chrome.runtime.sendMessage({ type: 'set-token', value: token });
});

// ---- Init ----
checkStatus();
urlInput.focus();
