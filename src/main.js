// RustyDownloader — Frontend Logic
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ---- State ----
let downloads = [];
let currentFilter = 'all';
let currentSearch = '';
let settings = {};
let segmentsData = {}; // { downloadId: [{ id, downloaded, total }, ...] }
let categoryRules = []; // cached category rules

// ---- DOM Elements ----
const downloadList = document.getElementById('download-list');
const emptyState = document.getElementById('empty-state');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');
const searchInput = document.getElementById('search-downloads');
const searchClear = document.getElementById('search-clear');
const visibleCount = document.getElementById('visible-count');
const activeCount = document.getElementById('active-count');
const completedCount = document.getElementById('completed-count');
const searchState = document.getElementById('search-state');

// Nav items
const navItems = document.querySelectorAll('.nav-item[data-filter]');
const badgeAll = document.getElementById('badge-all');
const badgeDownloading = document.getElementById('badge-downloading');
const badgeCompleted = document.getElementById('badge-completed');
const badgeFailed = document.getElementById('badge-failed');

// Add Download Modal
const modalAdd = document.getElementById('modal-add');
const btnAddDownload = document.getElementById('btn-add-download');
const btnCloseAdd = document.getElementById('modal-add-close');
const btnCancelAdd = document.getElementById('btn-cancel-add');
const btnStartDownload = document.getElementById('btn-start-download');
const inputUrl = document.getElementById('input-url');
const inputFilename = document.getElementById('input-filename');
const inputSavePath = document.getElementById('input-savepath');
const btnBrowse = document.getElementById('btn-browse');
const fileInfoDiv = document.getElementById('file-info');
const infoSize = document.getElementById('info-size');
const infoType = document.getElementById('info-type');
const infoResumable = document.getElementById('info-resumable');

// Settings Modal
const modalSettings = document.getElementById('modal-settings');
const btnSettings = document.getElementById('btn-settings');
const btnCloseSettings = document.getElementById('modal-settings-close');
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const btnSaveSettings = document.getElementById('btn-save-settings');
const settingsDir = document.getElementById('settings-dir');
const settingsConcurrent = document.getElementById('settings-concurrent');
const settingsSegments = document.getElementById('settings-segments');
const btnBrowseSettings = document.getElementById('btn-browse-settings');

// ---- Helpers ----
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond === 0) return '—';
  return formatBytes(bytesPerSecond) + '/s';
}

function formatETA(downloaded, total, speed) {
  if (speed <= 0 || total <= 0) return '—';
  const remaining = total - downloaded;
  const seconds = Math.ceil(remaining / speed);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function getFileExtension(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toUpperCase() : 'FILE';
}

function getStatusColor(status) {
  const colors = {
    'Downloading': 'downloading',
    'Completed': 'completed',
    'Paused': 'paused',
    'Failed': 'failed',
    'Cancelled': 'cancelled',
    'Queued': 'queued',
  };
  return colors[status] || 'queued';
}

// ---- Render ----
function renderDownloads() {
  const filtered = filterDownloads(downloads);
  updateBadges();
  updateOverview(filtered);

  // Remove existing items (except empty state)
  downloadList.querySelectorAll('.download-item').forEach(el => el.remove());

  if (filtered.length === 0) {
    emptyState.style.display = 'flex';
    emptyState.querySelector('h3').textContent = currentSearch ? 'No matching downloads' : 'No downloads yet';
    emptyState.querySelector('p').textContent = currentSearch
      ? `No results found for "${currentSearch}" in this view.`
      : 'Click "New Download" to start downloading files';
    return;
  }

  emptyState.style.display = 'none';

  filtered.forEach(item => {
    const existing = document.getElementById(`dl-${item.id}`);
    if (existing) {
      updateDownloadItem(existing, item);
    } else {
      const el = createDownloadItem(item);
      downloadList.appendChild(el);
    }
  });
}

function filterDownloads(items) {
  const keyword = currentSearch.trim().toLowerCase();

  return items.filter(d => {
    const matchesFilter = (() => {
      switch (currentFilter) {
        case 'downloading':
          return d.status === 'Downloading' || d.status === 'Queued';
        case 'completed':
          return d.status === 'Completed';
        case 'failed':
          return d.status === 'Failed' || d.status === 'Cancelled';
        default:
          return true;
      }
    })();

    if (!matchesFilter) return false;
    if (!keyword) return true;

    const haystack = [
      d.filename || '',
      d.status || '',
      getFileExtension(d.filename || ''),
      formatBytes(d.total_size || 0),
      formatBytes(d.downloaded || 0),
    ].join(' ').toLowerCase();

    return haystack.includes(keyword);
  });
}

function updateOverview(filtered) {
  if (visibleCount) visibleCount.textContent = filtered.length;
  if (activeCount) activeCount.textContent = downloads.filter(d => d.status === 'Downloading' || d.status === 'Queued').length;
  if (completedCount) completedCount.textContent = downloads.filter(d => d.status === 'Completed').length;
  if (searchState) searchState.textContent = currentSearch ? `"${currentSearch}"` : 'All files';
  if (searchClear) searchClear.classList.toggle('visible', Boolean(currentSearch));
}

function updateBadges() {
  badgeAll.textContent = downloads.length;
  badgeDownloading.textContent = downloads.filter(d => d.status === 'Downloading' || d.status === 'Queued').length;
  badgeCompleted.textContent = downloads.filter(d => d.status === 'Completed').length;
  badgeFailed.textContent = downloads.filter(d => d.status === 'Failed' || d.status === 'Cancelled').length;
}

function createDownloadItem(item) {
  const statusClass = getStatusColor(item.status);
  const ext = getFileExtension(item.filename || '');
  const progress = item.total_size > 0 ? ((item.downloaded / item.total_size) * 100) : 0;
  const segs = segmentsData[item.id] || [];
  const isActive = item.status === 'Downloading' || item.status === 'Queued';
  const statusMeta = isActive
    ? `${formatSpeed(item.speed)} • ETA ${formatETA(item.downloaded, item.total_size, item.speed)}`
    : item.status;

  const el = document.createElement('div');
  el.className = 'download-item';
  el.id = `dl-${item.id}`;
  el.dataset.id = item.id;
  el.dataset.lastStatus = item.status;

  const safeFilename = escapeHtml(item.filename || 'Unknown');
  const safeExt = escapeHtml(ext.substring(0, 4));
  const safeId = escapeAttr(item.id);

  // Build segment bars HTML (no user data, safe)
  let segmentHTML = '';
  if (segs.length > 1 && item.status === 'Downloading') {
    const segBlocks = segs.map((s, i) => {
      const pct = s.total > 0 ? ((s.downloaded / s.total) * 100) : 0;
      return `<div class="segment-block"><div class="segment-block-fill seg-${i % 16}" style="width: ${pct}%"></div></div>`;
    }).join('');
    const segLabels = segs.map((s, i) => {
      const pct = s.total > 0 ? ((s.downloaded / s.total) * 100).toFixed(0) : 0;
      return `<div class="segment-label">#${i + 1}: ${pct}%</div>`;
    }).join('');
    segmentHTML = `
      <div class="segments-container">
        <div class="segment-bar-wrapper">${segBlocks}</div>
        <div class="segment-labels">${segLabels}</div>
      </div>`;
  }

  el.innerHTML = `
    <div class="download-item-topline">
      <div class="file-icon ${statusClass}">${safeExt}</div>
      <div class="download-main">
        <div class="download-title-row">
          <div class="download-filename" title="${escapeAttr(item.filename || 'Unknown')}">${safeFilename}</div>
          <span class="status-badge ${statusClass}">${escapeHtml(item.status)}</span>
        </div>
        <div class="download-meta-grid">
          <span class="meta-chip">${formatBytes(item.downloaded)}${item.total_size > 0 ? ' / ' + formatBytes(item.total_size) : ''}</span>
          <span class="meta-chip">${escapeHtml(ext)}</span>
          <span class="meta-chip download-status-detail">${escapeHtml(statusMeta)}</span>
          ${segs.length > 1 ? `<span class="meta-chip">${segs.length} threads</span>` : ''}
        </div>
      </div>
      <div class="download-actions">
        ${item.status === 'Downloading' ? `
          <button class="btn-icon" data-action="pause" data-id="${safeId}" title="Pause">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          </button>
        ` : ''}
        ${item.status === 'Paused' || item.status === 'Failed' ? `
          <button class="btn-icon" data-action="resume" data-id="${safeId}" title="Resume">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
        ` : ''}
        ${item.status !== 'Completed' ? `
          <button class="btn-icon danger" data-action="cancel" data-id="${safeId}" title="Cancel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        ` : ''}
        ${item.status === 'Completed' && item.filename && item.filename.toLowerCase().endsWith('.ts') ? `
          <button class="btn-icon convert-btn" data-action="convert" data-id="${safeId}" title="Convert to MP4">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </button>
        ` : ''}
        <button class="btn-icon danger" data-action="remove" data-id="${safeId}" title="Remove">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
    <div class="progress-container compact">
      <div class="progress-bar-wrapper">
        <div class="progress-bar ${statusClass}" style="width: ${progress}%"></div>
      </div>
      <span class="progress-text">${progress.toFixed(1)}%</span>
    </div>
    ${segmentHTML}
  `;

  return el;
}
function updateDownloadItem(el, item) {
  const statusClass = getStatusColor(item.status);
  const progress = item.total_size > 0 ? ((item.downloaded / item.total_size) * 100) : 0;

  // Update progress bar
  const bar = el.querySelector('.progress-bar');
  if (bar) {
    bar.style.width = `${progress}%`;
    bar.className = `progress-bar ${statusClass}`;
  }

  // Update progress text
  const pText = el.querySelector('.progress-text');
  if (pText) pText.textContent = `${progress.toFixed(1)}%`;

  // Update compact metadata
  const metaEls = el.querySelectorAll('.meta-chip');
  if (metaEls[0]) {
    metaEls[0].textContent = `${formatBytes(item.downloaded)}${item.total_size > 0 ? ' / ' + formatBytes(item.total_size) : ''}`;
  }
  if (metaEls[1]) {
    metaEls[1].textContent = getFileExtension(item.filename || '');
  }
  if (metaEls[2]) {
    const isActive = item.status === 'Downloading' || item.status === 'Queued';
    metaEls[2].textContent = isActive
      ? `${formatSpeed(item.speed)} • ETA ${formatETA(item.downloaded, item.total_size, item.speed)}`
      : item.status;
  }
  if (metaEls[3] && metaEls[3].textContent.includes('threads')) {
    metaEls[3].textContent = `${(segmentsData[item.id] || []).length} threads`;
  }

  // Update filename display if changed
  const fnEl = el.querySelector('.download-filename');
  if (fnEl && item.filename && fnEl.textContent !== item.filename) {
    fnEl.textContent = item.filename;
    fnEl.title = item.filename;
    // Also update the file extension icon
    const ext = getFileExtension(item.filename);
    const icon = el.querySelector('.file-icon');
    if (icon) icon.textContent = ext.substring(0, 4);
  }

  // Update file icon status color
  const icon = el.querySelector('.file-icon');
  if (icon) icon.className = `file-icon ${statusClass}`;

  // Update per-segment progress bars
  const segs = segmentsData[item.id] || [];
  if (segs.length > 1 && item.status === 'Downloading') {
    const fills = el.querySelectorAll('.segment-block-fill');
    const labels = el.querySelectorAll('.segment-label');
    if (fills.length === segs.length) {
      segs.forEach((s, i) => {
        const pct = s.total > 0 ? ((s.downloaded / s.total) * 100) : 0;
        fills[i].style.width = `${pct}%`;
        if (labels[i]) labels[i].textContent = `#${i + 1}: ${pct.toFixed(0)}%`;
      });
    } else {
      // Segment count changed, re-render
      const newEl = createDownloadItem(item);
      el.replaceWith(newEl);
      return;
    }
  }

  // If status changed, re-render the whole item
  if (el.dataset.lastStatus && el.dataset.lastStatus !== item.status) {
    const newEl = createDownloadItem(item);
    el.replaceWith(newEl);
  }
  el.dataset.lastStatus = item.status;
}

// ---- Actions (event delegation) ----
downloadList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (!id) return;
  switch (action) {
    case 'pause': handlePause(id); break;
    case 'resume': handleResume(id); break;
    case 'cancel': handleCancel(id); break;
    case 'remove': handleRemove(id); break;
    case 'convert': handleConvert(id); break;
  }
});

async function handlePause(id) {
  try {
    await invoke('pause_download', { id });
  } catch (e) {
    console.error('Pause error:', e);
  }
}

async function handleResume(id) {
  try {
    await invoke('resume_download', { id });
  } catch (e) {
    console.error('Resume error:', e);
  }
}

async function handleCancel(id) {
  try {
    await invoke('cancel_download', { id });
  } catch (e) {
    console.error('Cancel error:', e);
  }
}

async function handleRemove(id) {
  try {
    await invoke('remove_download', { id });
    downloads = downloads.filter(d => d.id !== id);
    renderDownloads();
  } catch (e) {
    console.error('Remove error:', e);
  }
}

async function handleConvert(id) {
  const btn = document.querySelector(`#dl-${id} .convert-btn`);
  if (btn) {
    btn.disabled = true;
    btn.title = 'Converting...';
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
    btn.style.animation = 'spin 1s linear infinite';
  }
  try {
    const mp4Path = await invoke('convert_to_mp4', { id });
    if (btn) {
      btn.style.animation = '';
      btn.innerHTML = '✓';
      btn.title = 'Converted: ' + mp4Path;
      btn.style.color = 'var(--success)';
    }
  } catch (e) {
    console.error('Convert error:', e);
    if (btn) {
      btn.disabled = false;
      btn.style.animation = '';
      btn.innerHTML = '!';
      btn.title = 'Error: ' + e;
      btn.style.color = 'var(--danger)';
      setTimeout(() => {
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
        btn.title = 'Convert to MP4';
        btn.style.color = '';
      }, 3000);
    }
  }
};

// ---- Event Listeners ----

// Navigation
navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    currentFilter = item.dataset.filter;

    const titles = {
      all: 'All Downloads',
      downloading: 'Downloading',
      completed: 'Completed',
      failed: 'Failed',
    };
    const subtitles = {
      all: 'Track, search, and manage your download history in one compact view.',
      downloading: 'Monitor active jobs with denser cards and faster scanning.',
      completed: 'Search completed files instantly when your history grows large.',
      failed: 'Find interrupted downloads quickly and resume what matters.',
    };

    pageTitle.textContent = titles[currentFilter] || 'All Downloads';
    if (pageSubtitle) pageSubtitle.textContent = subtitles[currentFilter] || subtitles.all;
    renderDownloads();
  });
});

if (searchInput) {
  searchInput.addEventListener('input', (event) => {
    currentSearch = event.target.value.trim();
    renderDownloads();
  });
}

if (searchClear) {
  searchClear.addEventListener('click', () => {
    currentSearch = '';
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    renderDownloads();
  });
}

// Add Download Modal
btnAddDownload.addEventListener('click', async () => {
  modalAdd.style.display = 'flex';
  inputUrl.value = '';
  inputFilename.value = '';
  fileInfoDiv.style.display = 'none';

  // Load settings for default save path
  try {
    settings = await invoke('get_settings');
    inputSavePath.value = settings.download_dir || '';
  } catch (e) {
    console.error('Settings error:', e);
  }

  setTimeout(() => inputUrl.focus(), 100);
});

btnCloseAdd.addEventListener('click', () => modalAdd.style.display = 'none');
btnCancelAdd.addEventListener('click', () => modalAdd.style.display = 'none');

// URL change — fetch file info
let urlDebounce = null;
inputUrl.addEventListener('input', () => {
  clearTimeout(urlDebounce);
  urlDebounce = setTimeout(async () => {
    const url = inputUrl.value.trim();
    if (!url || !url.startsWith('http')) {
      fileInfoDiv.style.display = 'none';
      return;
    }
    try {
      const info = await invoke('get_file_info', { url });
      inputFilename.value = info.filename || '';
      infoSize.textContent = info.size > 0 ? formatBytes(info.size) : 'Unknown';
      infoType.textContent = info.content_type || 'Unknown';
      infoResumable.textContent = info.resumable ? '✓ Yes' : '✗ No';
      infoResumable.style.color = info.resumable ? 'var(--success)' : 'var(--danger)';
      fileInfoDiv.style.display = 'flex';

      // Auto-resolve save path based on extension
      if (info.filename) {
        try {
          const resolved = await invoke('resolve_save_path', { filename: info.filename });
          inputSavePath.value = resolved;
        } catch (_) { }
      }
    } catch (e) {
      console.error('File info error:', e);
      fileInfoDiv.style.display = 'none';
    }
  }, 500);
});

// Browse button
btnBrowse.addEventListener('click', async () => {
  try {
    const { open } = window.__TAURI__.dialog;
    const selected = await open({ directory: true, title: 'Select Download Directory' });
    if (selected) {
      inputSavePath.value = selected;
    }
  } catch (e) {
    console.error('Browse error:', e);
  }
});

// Start download
btnStartDownload.addEventListener('click', async () => {
  const url = inputUrl.value.trim();
  const filename = inputFilename.value.trim();
  const savePath = inputSavePath.value.trim();

  if (!url) {
    inputUrl.focus();
    return;
  }

  try {
    const result = await invoke('add_download', {
      url,
      filename: filename || '',
      savePath: savePath || settings.download_dir || '',
    });
    downloads.unshift(result);
    renderDownloads();
    modalAdd.style.display = 'none';
  } catch (e) {
    console.error('Add download error:', e);
  }
});

// Settings Modal
const settingsRetries = document.getElementById('settings-retries');

btnSettings.addEventListener('click', async () => {
  try {
    settings = await invoke('get_settings');
    settingsDir.value = settings.download_dir || '';
    settingsConcurrent.value = settings.max_concurrent || 3;
    settingsSegments.value = settings.max_segments || 8;
    if (settingsRetries) settingsRetries.value = settings.max_retries || 3;
    categoryRules = settings.category_rules || [];
    renderCategoryRules();

    // Load API token
    try {
      const token = await invoke('get_api_token');
      const tokenInput = document.getElementById('settings-api-token');
      if (tokenInput) tokenInput.value = token || '';
    } catch (_) {}

    modalSettings.style.display = 'flex';
  } catch (e) {
    console.error('Settings error:', e);
  }
});

btnCloseSettings.addEventListener('click', () => modalSettings.style.display = 'none');
btnCancelSettings.addEventListener('click', () => modalSettings.style.display = 'none');

btnBrowseSettings.addEventListener('click', async () => {
  try {
    const { open } = window.__TAURI__.dialog;
    const selected = await open({ directory: true, title: 'Select Default Download Directory' });
    if (selected) {
      settingsDir.value = selected;
    }
  } catch (e) {
    console.error('Browse error:', e);
  }
});

btnSaveSettings.addEventListener('click', async () => {
  try {
    // Collect category rules from the UI
    collectCategoryRulesFromUI();

    await invoke('update_settings', {
      downloadDir: settingsDir.value,
      maxConcurrent: parseInt(settingsConcurrent.value) || 3,
      maxSegments: parseInt(settingsSegments.value) || 8,
      maxRetries: parseInt(settingsRetries?.value) || 3,
      categoryRules: categoryRules,
    });
    modalSettings.style.display = 'none';
  } catch (e) {
    console.error('Save settings error:', e);
  }
});

// ---- Category Rules ----
const categoryRulesList = document.getElementById('category-rules-list');
const btnAddRule = document.getElementById('btn-add-rule');

function renderCategoryRules() {
  categoryRulesList.innerHTML = '';
  categoryRules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <input type="text" class="rule-name" value="${escapeAttr(rule.name)}" placeholder="Category" />
      <input type="text" class="rule-ext" value="${escapeAttr(rule.extensions.join(', '))}" placeholder="zip, rar, 7z" />
      <input type="text" class="rule-folder" value="${escapeAttr(rule.subfolder)}" placeholder="Subfolder" />
      <button class="btn-icon danger btn-delete-rule" data-idx="${idx}" title="Delete rule">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    categoryRulesList.appendChild(row);
  });

  // Attach delete handlers
  categoryRulesList.querySelectorAll('.btn-delete-rule').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      categoryRules.splice(idx, 1);
      renderCategoryRules();
    });
  });
}

function collectCategoryRulesFromUI() {
  const rows = categoryRulesList.querySelectorAll('.rule-row');
  categoryRules = [];
  rows.forEach(row => {
    const name = row.querySelector('.rule-name').value.trim();
    const extStr = row.querySelector('.rule-ext').value.trim();
    const subfolder = row.querySelector('.rule-folder').value.trim();
    if (name && extStr && subfolder) {
      categoryRules.push({
        name,
        extensions: extStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
        subfolder,
      });
    }
  });
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

btnAddRule.addEventListener('click', () => {
  collectCategoryRulesFromUI();
  categoryRules.push({ name: '', extensions: [], subfolder: '' });
  renderCategoryRules();
  // Focus the new row's name input
  const rows = categoryRulesList.querySelectorAll('.rule-row');
  if (rows.length > 0) {
    rows[rows.length - 1].querySelector('.rule-name').focus();
  }
});

// Copy API token button
const btnCopyToken = document.getElementById('btn-copy-token');
if (btnCopyToken) {
  btnCopyToken.addEventListener('click', () => {
    const tokenInput = document.getElementById('settings-api-token');
    if (tokenInput && tokenInput.value) {
      navigator.clipboard.writeText(tokenInput.value).then(() => {
        btnCopyToken.textContent = 'Copied!';
        setTimeout(() => { btnCopyToken.textContent = 'Copy'; }, 2000);
      });
    }
  });
}

// Close modals on overlay click
modalAdd.addEventListener('click', (e) => {
  if (e.target === modalAdd) modalAdd.style.display = 'none';
});
modalSettings.addEventListener('click', (e) => {
  if (e.target === modalSettings) modalSettings.style.display = 'none';
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    modalAdd.style.display = 'none';
    modalSettings.style.display = 'none';
  }
});

// ---- Tauri Events ----
listen('download-progress', (event) => {
  const progress = event.payload;
  const idx = downloads.findIndex(d => d.id === progress.id);

  // Store segment-level progress
  if (progress.segments && progress.segments.length > 0) {
    segmentsData[progress.id] = progress.segments;
  }

  if (idx >= 0) {
    downloads[idx].downloaded = progress.downloaded;
    downloads[idx].total_size = progress.total_size;
    downloads[idx].speed = progress.speed;
    downloads[idx].status = progress.status;
    // Update filename if resolved by backend
    if (progress.filename && progress.filename !== downloads[idx].filename) {
      downloads[idx].filename = progress.filename;
    }

    // Update UI
    const el = document.getElementById(`dl-${progress.id}`);
    if (el) {
      updateDownloadItem(el, downloads[idx]);
    }
    updateBadges();
  }
});

// Listen for downloads added via browser extension
listen('download-added', (event) => {
  const item = event.payload;
  // Avoid duplicates
  if (!downloads.find(d => d.id === item.id)) {
    downloads.unshift(item);
    renderDownloads();
  }
});

// ---- Tray Events ----
listen('tray-pause-all', () => {
  downloads.filter(d => d.status === 'Downloading').forEach(d => {
    handlePause(d.id);
  });
});

listen('tray-resume-all', () => {
  downloads.filter(d => d.status === 'Paused').forEach(d => {
    handleResume(d.id);
  });
});

listen('tray-open-settings', () => {
  btnSettings.click();
});

// ---- Init ----
let _initialized = false;
async function init() {
  if (_initialized) return;
  _initialized = true;
  try {
    const items = await invoke('get_downloads');
    downloads = items || [];
    renderDownloads();

    settings = await invoke('get_settings');
  } catch (e) {
    console.error('Init error:', e);
  }
}

// Wait for DOM ready
document.addEventListener('DOMContentLoaded', init);
// If DOM already loaded
if (document.readyState !== 'loading') {
  init();
}
