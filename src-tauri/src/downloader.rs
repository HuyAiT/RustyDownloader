use crate::download_manager::{DownloadItem, DownloadManager, DownloadStatus, SegmentInfo};
use futures_util::StreamExt;
use reqwest::Client;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::watch;

#[derive(Clone, serde::Serialize)]
pub struct SegmentProgress {
    pub id: usize,
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub filename: String,
    pub downloaded: u64,
    pub total_size: u64,
    pub speed: u64,
    pub status: DownloadStatus,
    pub progress_percent: f64,
    pub segments: Vec<SegmentProgress>,
}

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub async fn start_download(
    app: AppHandle,
    manager: Arc<DownloadManager>,
    download_id: String,
) -> Result<(), String> {
    // Wait for a free download slot before starting
    manager.wait_for_download_slot(&download_id).await?;

    let settings = manager.settings.lock().await;
    let max_retries = settings.max_retries;
    drop(settings);

    let mut retries = 0;

    loop {
        match try_download(app.clone(), manager.clone(), download_id.clone()).await {
            Ok(()) => {
                // Clean up browser cookies after successful download
                manager.download_cookies.lock().await.remove(&download_id);
                manager.notify_slot_available();
                return Ok(());
            }
            Err(e) => {
                // Check if cancelled or paused — don't retry
                if let Some(item) = manager.get_download(&download_id).await {
                    if item.status == DownloadStatus::Cancelled
                        || item.status == DownloadStatus::Paused
                    {
                        manager.notify_slot_available();
                        return Ok(());
                    }
                }

                retries += 1;
                if retries > max_retries {
                    // Max retries reached, mark as failed
                    if let Some(mut item) = manager.get_download(&download_id).await {
                        item.status = DownloadStatus::Failed;
                        item.error = Some(format!("{} (after {} retries)", e, max_retries));
                        item.speed = 0;
                        manager.update_download(item.clone()).await;
                        manager.remove_cancel_token(&item.id).await;
                        emit_progress(&app, &item, &[]);
                    }
                    manager.notify_slot_available();
                    return Err(e);
                }

                // Update status to show retry
                if let Some(mut item) = manager.get_download(&download_id).await {
                    item.error = Some(format!("Retry {}/{}: {}", retries, max_retries, e));
                    manager.update_download(item).await;
                }

                // Wait before retry (exponential backoff: 1s, 2s, 4s...)
                let delay = std::time::Duration::from_secs(1 << (retries - 1).min(4));
                tokio::time::sleep(delay).await;
            }
        }
    }
}

async fn try_download(
    app: AppHandle,
    manager: Arc<DownloadManager>,
    download_id: String,
) -> Result<(), String> {
    // Retrieve browser cookies forwarded by the extension (if any)
    let browser_cookies = {
        let cookies = manager.download_cookies.lock().await;
        cookies.get(&download_id).cloned()
    };

    let mut client_builder = Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .cookie_store(true)
        .connect_timeout(std::time::Duration::from_secs(10));

    // Inject browser cookies as a default header so all requests carry them.
    // This is critical for authenticated downloads (e.g. private Google Drive files).
    if let Some(ref cookies) = browser_cookies {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Ok(val) = reqwest::header::HeaderValue::from_str(cookies) {
            headers.insert(reqwest::header::COOKIE, val);
        }
        client_builder = client_builder.default_headers(headers);
    }

    let client = client_builder.build().map_err(|e| e.to_string())?;

    // Get download item
    let mut item = manager
        .get_download(&download_id)
        .await
        .ok_or("Download not found")?;

    // Normalize Google Drive URLs (add confirm=t to bypass virus scan warning)
    let request_url = crate::filename_resolver::normalize_gdrive_url(&item.url);

    // HEAD request to get file info
    let head_resp = client
        .head(&request_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    let total_size = head_resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let accept_ranges = head_resp
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "bytes")
        .unwrap_or(false);

    // Resolve filename from HEAD response if still empty or generic
    if item.filename.is_empty() || crate::filename_resolver::is_generic_filename(&item.filename) {
        let resolved = crate::filename_resolver::resolve_filename(&head_resp, &request_url);
        if !crate::filename_resolver::is_generic_filename(&resolved) {
            item.filename = resolved;
        }
    }

    // If still a generic filename, try a plain GET request.
    // Google Drive and some CDNs only return Content-Disposition on GET, not HEAD.
    // We only read headers — dropping the response cancels the body download.
    if crate::filename_resolver::is_generic_filename(&item.filename) {
        if let Ok(get_resp) = client.get(&request_url).send().await {
            let name = crate::filename_resolver::resolve_filename(&get_resp, &request_url);
            if !crate::filename_resolver::is_generic_filename(&name) {
                item.filename = name;
            }
        }
    }

    // Re-resolve save_path based on (possibly newly resolved) filename + category rules.
    // This ensures files whose names are only known after HEAD request (e.g. Google Drive)
    // still get sorted into the correct category subfolder.
    {
        let settings = manager.settings.lock().await;
        let category_path = settings.resolve_category_path(&item.filename);
        // Only update if save_path is still the base download_dir (not user-overridden)
        if item.save_path == settings.download_dir {
            item.save_path = category_path;
        }
    }

    // For Google Drive large files: resolve the actual binary download URL.
    // Large files return an HTML virus-scan confirmation page instead of the file.
    // We need to extract the real download URL from that page.
    let (request_url, total_size, accept_ranges) =
        resolve_gdrive_if_html(&client, &request_url, total_size, accept_ranges).await
            .unwrap_or((request_url, total_size, accept_ranges));

    // If filename was still generic, try resolving from the real URL
    if crate::filename_resolver::is_generic_filename(&item.filename) {
        if let Ok(get_resp) = client.head(&request_url).send().await {
            let name = crate::filename_resolver::resolve_filename(&get_resp, &request_url);
            if !crate::filename_resolver::is_generic_filename(&name) {
                item.filename = name;
                // Re-resolve save_path with the new filename
                let settings = manager.settings.lock().await;
                let category_path = settings.resolve_category_path(&item.filename);
                if item.save_path == settings.download_dir {
                    item.save_path = category_path;
                }
            }
        }
    }

    item.url = request_url;

    item.total_size = total_size;
    item.resumable = accept_ranges;
    item.status = DownloadStatus::Downloading;
    manager.update_download(item.clone()).await;

    // Create cancel token
    let (cancel_tx, cancel_rx) = watch::channel(false);
    manager.set_cancel_token(&download_id, cancel_tx).await;

    // Determine number of segments
    let settings = manager.settings.lock().await;
    let num_segments = if accept_ranges && total_size > 0 {
        settings.max_segments.min(16)
    } else {
        1
    };
    drop(settings);

    if num_segments > 1 && total_size > 0 {
        multi_segment_download(app, manager, client, item, num_segments, cancel_rx).await
    } else {
        single_download(app, manager, client, item, cancel_rx).await
    }
}

/// For Google Drive large files, the server returns an HTML virus-scan confirmation
/// page instead of the actual file. This function detects that scenario by making a
/// GET request and checking if the response is HTML. If so, it parses the page to
/// extract the real download URL from the embedded `<form id="download-form">`.
///
/// Returns `(resolved_url, total_size, accept_ranges)`.
async fn resolve_gdrive_if_html(
    client: &Client,
    url: &str,
    original_size: u64,
    original_accept_ranges: bool,
) -> Result<(String, u64, bool), String> {
    let is_gdrive = url.contains("drive.google.com") || url.contains("drive.usercontent.google.com");
    if !is_gdrive {
        return Ok((url.to_string(), original_size, original_accept_ranges));
    }

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GDrive resolve failed: {}", e))?;

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let final_url = resp.url().clone();

    // If the response is not HTML, the URL is already a direct download
    if !content_type.contains("text/html") {
        return Ok((url.to_string(), original_size, original_accept_ranges));
    }

    // Read the HTML body to find the actual download form
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read GDrive page: {}", e))?;

    // Extract the download URL from <form id="download-form" action="URL">
    let real_url = extract_gdrive_form_action(&body, &final_url)
        .ok_or_else(|| "Could not find download link on Google Drive confirmation page".to_string())?;

    // HEAD the real URL to get accurate file info
    let head_resp = client
        .head(&real_url)
        .send()
        .await
        .map_err(|e| format!("GDrive HEAD failed: {}", e))?;

    let total_size = head_resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(original_size);

    let accept_ranges = head_resp
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "bytes")
        .unwrap_or(original_accept_ranges);

    println!("[GDrive] Resolved virus-scan page -> real URL");

    Ok((real_url, total_size, accept_ranges))
}

/// Parse a Google Drive virus-scan HTML page and extract the download form action URL.
fn extract_gdrive_form_action(html: &str, page_url: &reqwest::Url) -> Option<String> {
    // Look for: <form id="download-form" action="...">
    // or: <form id="downloadForm" action="...">
    for form_id in &["download-form", "downloadForm"] {
        let pattern = format!("id=\"{}\"", form_id);
        if let Some(form_pos) = html.find(&pattern) {
            // Find the enclosing <form ...> tag by searching backwards for '<form' and forwards for '>'
            let before = &html[..form_pos];
            let form_start = before.rfind("<form").unwrap_or(form_pos.saturating_sub(500));
            let after_form = &html[form_pos..];
            let form_end = form_pos + after_form.find('>').unwrap_or(500);
            let form_tag = &html[form_start..html.len().min(form_end + 1)];

            if let Some(action_pos) = form_tag.find("action=\"") {
                let after = &form_tag[action_pos + 8..];
                if let Some(end) = after.find('"') {
                    let action = &after[..end];
                    // Decode HTML entities
                    let action = action.replace("&amp;", "&");

                    if action.starts_with("http") {
                        return Some(action);
                    } else {
                        // Relative URL — resolve against the page URL
                        let base = format!(
                            "{}://{}",
                            page_url.scheme(),
                            page_url.host_str().unwrap_or("drive.usercontent.google.com")
                        );
                        return Some(format!("{}{}", base, action));
                    }
                }
            }
        }
    }

    // Fallback: look for any link with /download and uuid= parameter
    for pattern in &["href=\"", "action=\""] {
        let mut search_from = 0;
        while let Some(pos) = html[search_from..].find(pattern) {
            let abs_pos = search_from + pos + pattern.len();
            if let Some(end) = html[abs_pos..].find('"') {
                let url_str = &html[abs_pos..abs_pos + end];
                let url_str = url_str.replace("&amp;", "&");
                if url_str.contains("download") && url_str.contains("uuid=") {
                    if url_str.starts_with("http") {
                        return Some(url_str);
                    } else {
                        let base = format!(
                            "{}://{}",
                            page_url.scheme(),
                            page_url.host_str().unwrap_or("drive.usercontent.google.com")
                        );
                        return Some(format!("{}{}", base, url_str));
                    }
                }
            }
            search_from = abs_pos;
        }
    }

    None
}

async fn single_download(
    app: AppHandle,
    manager: Arc<DownloadManager>,
    client: Client,
    mut item: DownloadItem,
    cancel_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let file_path = item.full_path();

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let resp = client
        .get(&item.url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    let mut file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut last_downloaded: u64 = 0;

    // Single segment progress
    let seg_total = item.total_size;

    while let Some(chunk_result) = stream.next().await {
        if *cancel_rx.borrow() {
            item.status = DownloadStatus::Cancelled;
            manager.update_download(item.clone()).await;
            manager.remove_cancel_token(&item.id).await;
            emit_progress(&app, &item, &[SegmentProgress { id: 0, downloaded, total: seg_total }]);
            return Ok(());
        }

        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {}", e))?;

        downloaded += chunk.len() as u64;
        item.downloaded = downloaded;

        let now = std::time::Instant::now();
        if now.duration_since(last_emit).as_millis() >= 100 {
            let elapsed = now.duration_since(last_emit).as_secs_f64();
            if elapsed > 0.0 {
                item.speed = ((downloaded - last_downloaded) as f64 / elapsed) as u64;
            }
            last_downloaded = downloaded;
            last_emit = now;
            let seg = vec![SegmentProgress { id: 0, downloaded, total: seg_total }];
            emit_progress(&app, &item, &seg);
            manager.update_download(item.clone()).await;
        }
    }

    file.flush().await.map_err(|e| format!("Flush error: {}", e))?;

    item.status = DownloadStatus::Completed;
    item.downloaded = downloaded;
    item.speed = 0;
    item.completed_at = Some(chrono::Utc::now());
    manager.update_download(item.clone()).await;
    manager.remove_cancel_token(&item.id).await;
    emit_progress(&app, &item, &[SegmentProgress { id: 0, downloaded, total: seg_total }]);

    Ok(())
}

async fn multi_segment_download(
    app: AppHandle,
    manager: Arc<DownloadManager>,
    client: Client,
    mut item: DownloadItem,
    num_segments: usize,
    cancel_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let total_size = item.total_size;
    let segment_size = total_size / num_segments as u64;
    let file_path = item.full_path();

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Create segments
    let mut segments: Vec<SegmentInfo> = Vec::new();
    for i in 0..num_segments {
        let start = i as u64 * segment_size;
        let end = if i == num_segments - 1 {
            total_size - 1
        } else {
            (i as u64 + 1) * segment_size - 1
        };
        segments.push(SegmentInfo {
            id: i,
            start,
            end,
            downloaded: 0,
        });
    }

    item.segments = segments.clone();
    manager.update_download(item.clone()).await;

    // Pre-allocate file
    let file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;
    file.set_len(total_size)
        .await
        .map_err(|e| format!("Failed to pre-allocate file: {}", e))?;
    drop(file);

    // Shared progress tracking per segment
    let segment_progress: Arc<tokio::sync::Mutex<Vec<u64>>> =
        Arc::new(tokio::sync::Mutex::new(vec![0u64; num_segments]));

    // Spawn segment download tasks
    let mut handles = Vec::new();

    for seg in segments.iter() {
        let client = client.clone();
        let url = item.url.clone();
        let path = file_path.clone();
        let seg_id = seg.id;
        let seg_start = seg.start;
        let seg_end = seg.end;
        let progress = segment_progress.clone();
        let cancel = cancel_rx.clone();

        let handle = tokio::spawn(async move {
            download_segment(client, url, path, seg_id, seg_start, seg_end, progress, cancel).await
        });
        handles.push(handle);
    }

    // Progress monitoring task — emits per-segment progress
    let progress_monitor = segment_progress.clone();
    let app_clone = app.clone();
    let manager_clone = manager.clone();
    let item_id = item.id.clone();
    let total = total_size;
    let cancel_monitor = cancel_rx.clone();
    let segments_clone = segments.clone();

    let monitor_handle = tokio::spawn(async move {
        let mut last_total: u64 = 0;
        let mut last_time = std::time::Instant::now();

        loop {
            if *cancel_monitor.borrow() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;

            let prog = progress_monitor.lock().await;
            let current_total: u64 = prog.iter().sum();

            // Build per-segment progress data
            let seg_progress: Vec<SegmentProgress> = segments_clone
                .iter()
                .enumerate()
                .map(|(i, seg)| SegmentProgress {
                    id: seg.id,
                    downloaded: prog[i],
                    total: seg.end - seg.start + 1,
                })
                .collect();
            drop(prog);

            let now = std::time::Instant::now();
            let elapsed = now.duration_since(last_time).as_secs_f64();
            let speed = if elapsed > 0.0 {
                ((current_total.saturating_sub(last_total)) as f64 / elapsed) as u64
            } else {
                0
            };

            if let Some(mut dl) = manager_clone.get_download(&item_id).await {
                dl.downloaded = current_total;
                dl.speed = speed;
                emit_progress(&app_clone, &dl, &seg_progress);
                manager_clone.update_download(dl).await;
            }

            last_total = current_total;
            last_time = now;

            if current_total >= total {
                break;
            }
        }
    });

    // Wait for all segments, aborting remaining tasks on cancel or error
    let mut all_ok = true;
    let mut error_msg = String::new();
    let total_handles = handles.len();
    for i in 0..total_handles {
        // Check cancel before waiting for next segment
        if *cancel_rx.borrow() {
            // Abort all remaining segment tasks
            for h in handles.iter().skip(i) {
                h.abort();
            }
            break;
        }
        match (&mut handles[i]).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                all_ok = false;
                error_msg = e;
            }
            Err(e) if e.is_cancelled() => {
                // Task was aborted due to cancel
            }
            Err(e) => {
                all_ok = false;
                error_msg = format!("Task error: {}", e);
            }
        }
    }

    monitor_handle.abort();

    // Final status
    if *cancel_rx.borrow() {
        item.status = DownloadStatus::Cancelled;
    } else if all_ok {
        item.status = DownloadStatus::Completed;
        item.downloaded = total_size;
        item.completed_at = Some(chrono::Utc::now());
    } else {
        item.status = DownloadStatus::Failed;
        item.error = Some(error_msg.clone());
    }

    item.speed = 0;
    manager.update_download(item.clone()).await;
    manager.remove_cancel_token(&item.id).await;
    emit_progress(&app, &item, &[]);

    if !all_ok && item.status == DownloadStatus::Failed {
        return Err(error_msg);
    }

    Ok(())
}

async fn download_segment(
    client: Client,
    url: String,
    file_path: std::path::PathBuf,
    seg_id: usize,
    start: u64,
    end: u64,
    progress: Arc<tokio::sync::Mutex<Vec<u64>>>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let range = format!("bytes={}-{}", start, end);
    let resp = client
        .get(&url)
        .header(reqwest::header::RANGE, range)
        .send()
        .await
        .map_err(|e| format!("Segment {} request failed: {}", seg_id, e))?;

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&file_path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| format!("Seek error: {}", e))?;

    let mut stream = resp.bytes_stream();
    let mut seg_downloaded: u64 = 0;

    while let Some(chunk_result) = stream.next().await {
        if *cancel_rx.borrow() {
            return Ok(());
        }

        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {}", e))?;

        seg_downloaded += chunk.len() as u64;
        let mut prog = progress.lock().await;
        prog[seg_id] = seg_downloaded;
    }

    Ok(())
}

fn emit_progress(app: &AppHandle, item: &DownloadItem, segments: &[SegmentProgress]) {
    let progress = DownloadProgress {
        id: item.id.clone(),
        filename: item.filename.clone(),
        downloaded: item.downloaded,
        total_size: item.total_size,
        speed: item.speed,
        status: item.status.clone(),
        progress_percent: item.progress_percent(),
        segments: segments.to_vec(),
    };
    let _ = app.emit("download-progress", progress);
}
