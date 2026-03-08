use crate::download_manager::{DownloadManager, DownloadStatus};
use reqwest::Client;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

/// Download an HLS stream. If `direct_segments` contains URLs, uses those directly.
/// Otherwise fetches and parses the M3U8 playlist at `m3u8_url` to discover segments.
/// All segments are downloaded and concatenated into a single .ts output file.
pub async fn download_hls(
    app: AppHandle,
    manager: Arc<DownloadManager>,
    m3u8_url: String,
    filename: String,
    direct_segments: Vec<String>,
) -> Result<(), String> {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (compatible; RustyDownloader/1.0)")
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Resolve save path
    let save_filename = if filename.is_empty() {
        "stream.ts".to_string()
    } else if !filename.ends_with(".ts") {
        format!("{}.ts", filename.trim_end_matches(|c: char| c == '.'))
    } else {
        filename.clone()
    };

    let save_path = {
        let settings = manager.settings.lock().await;
        settings.resolve_category_path(&save_filename)
    };

    // Create a download item to track progress
    let display_url = if m3u8_url.is_empty() { "HLS Stream".to_string() } else { m3u8_url.clone() };
    let item = manager
        .add_download(display_url, save_filename.clone(), save_path.clone())
        .await;
    let download_id = item.id.clone();

    // Create cancel token for this HLS download
    let (cancel_tx, cancel_rx) = watch::channel(false);
    manager.set_cancel_token(&download_id, cancel_tx).await;

    // Wait for a free download slot before starting
    manager.wait_for_download_slot(&download_id).await?;

    // Notify frontend
    let _ = tauri::Emitter::emit(&app, "download-added", &item);

    // ---- Determine segments ----
    // ALWAYS prefer M3U8 playlist because it contains ALL segments for the full video.
    // The intercepted .ts URLs from the extension only contain what was played in the browser
    // (e.g. first 10 minutes), so they're incomplete. Use them only as fallback.
    let segments = if !m3u8_url.is_empty() {
        println!("[HLS] Fetching M3U8 playlist for complete segment list: {}", m3u8_url);
        let m3u8_content = client
            .get(&m3u8_url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch M3U8: {}", e))?
            .text()
            .await
            .map_err(|e| format!("Failed to read M3U8 body: {}", e))?;

        let base_url = get_base_url(&m3u8_url);

        // First check: is this a master playlist?
        let segs = if is_master_playlist(&m3u8_content) {
            println!("[HLS] Detected master playlist, looking for highest quality variant...");
            if let Some(variant) = parse_master_playlist(&m3u8_content, &base_url) {
                println!("[HLS] Using variant: {}", variant);
                let variant_content = client
                    .get(&variant)
                    .send()
                    .await
                    .map_err(|e| format!("Failed to fetch variant M3U8: {}", e))?
                    .text()
                    .await
                    .map_err(|e| format!("Failed to read variant M3U8: {}", e))?;

                let variant_base = get_base_url(&variant);
                parse_m3u8_segments(&variant_content, &variant_base)
            } else {
                println!("[HLS] Master playlist found but no variants detected");
                Vec::new()
            }
        } else {
            // It's a media playlist — parse segments directly
            parse_m3u8_segments(&m3u8_content, &base_url)
        };

        if segs.is_empty() && !direct_segments.is_empty() {
            println!("[HLS] M3U8 parse returned 0 segments, falling back to {} intercepted URLs", direct_segments.len());
            direct_segments
        } else if segs.is_empty() {
            update_status(&manager, &download_id, DownloadStatus::Failed,
                Some("No segments found in HLS playlist".into())).await;
            return Err("No segments found".into());
        } else {
            println!("[HLS] Found {} segments from M3U8 playlist", segs.len());
            segs
        }
    } else if !direct_segments.is_empty() {
        // No M3U8 URL — use the intercepted .ts URLs as best effort
        println!("[HLS] No M3U8 URL available, using {} intercepted segment URLs", direct_segments.len());
        direct_segments
    } else {
        update_status(&manager, &download_id, DownloadStatus::Failed,
            Some("No M3U8 URL and no segments captured".into())).await;
        return Err("No M3U8 URL and no segments captured".into());
    };

    download_segments(app, manager, client, segments, download_id, save_path, save_filename, cancel_rx).await
}

async fn download_segments(
    app: AppHandle,
    manager: Arc<DownloadManager>,
    client: Client,
    segments: Vec<String>,
    download_id: String,
    save_path: String,
    save_filename: String,
    cancel_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let total_segments = segments.len();

    // Update status to downloading
    {
        let mut item = manager.get_download(&download_id).await
            .ok_or("Download item not found")?;
        item.status = DownloadStatus::Downloading;
        item.total_size = total_segments as u64;
        manager.update_download(item).await;
    }

    // Create output directory
    let out_dir = std::path::PathBuf::from(&save_path);
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let out_path = out_dir.join(&save_filename);
    let mut out_file = tokio::fs::File::create(&out_path)
        .await
        .map_err(|e| format!("Failed to create output file: {}", e))?;

    let mut downloaded_segments = 0u64;
    let mut total_bytes: u64 = 0;
    let mut last_time = std::time::Instant::now();
    let mut last_bytes: u64 = 0;

    // Download segments in parallel chunks of 4
    const PARALLEL_CHUNKS: usize = 4;

    for chunk in segments.chunks(PARALLEL_CHUNKS) {
        // Check cancel before each batch
        if *cancel_rx.borrow() {
            let mut item = manager.get_download(&download_id).await
                .ok_or("Download item not found")?;
            item.status = DownloadStatus::Cancelled;
            item.speed = 0;
            manager.update_download(item).await;
            manager.remove_cancel_token(&download_id).await;
            manager.notify_slot_available();
            return Ok(());
        }

        // Download chunk of segments in parallel
        let mut handles = Vec::new();
        for seg_url in chunk {
            let client = client.clone();
            let url = seg_url.clone();
            handles.push(tokio::spawn(async move {
                let resp = client.get(&url).send().await
                    .map_err(|e| format!("Segment request failed: {}", e))?;
                resp.bytes().await
                    .map_err(|e| format!("Segment read failed: {}", e))
            }));
        }

        // Collect results in order and write sequentially to preserve segment order
        for (i, handle) in handles.into_iter().enumerate() {
            let bytes = handle.await
                .map_err(|e| format!("Task error: {}", e))?
                .map_err(|e| format!("Segment {} failed: {}", downloaded_segments as usize + i, e))?;

            out_file.write_all(&bytes).await
                .map_err(|e| format!("Write error: {}", e))?;

            total_bytes += bytes.len() as u64;
        }

        downloaded_segments += chunk.len() as u64;

        // Calculate speed
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(last_time).as_secs_f64();
        let speed = if elapsed > 0.0 {
            ((total_bytes - last_bytes) as f64 / elapsed) as u64
        } else {
            0
        };
        last_bytes = total_bytes;
        last_time = now;

        // Update progress
        if let Some(mut item) = manager.get_download(&download_id).await {
            // Use segment count for progress percent (total bytes unknown ahead of time)
            item.downloaded = downloaded_segments;
            item.total_size = total_segments as u64;
            item.speed = speed;
            manager.update_download(item).await;
        }

        let percent = (downloaded_segments as f64 / total_segments as f64) * 100.0;
        let _ = app.emit("download-progress", serde_json::json!({
            "id": download_id,
            "downloaded": total_bytes,
            "total_size": total_bytes,
            "speed": speed,
            "segments": [],
            "status": "Downloading",
            "percent": percent,
            "segment_progress": format!("{}/{}", downloaded_segments, total_segments),
        }));
    }

    out_file.flush().await.map_err(|e| format!("Failed to flush: {}", e))?;

    // Mark completed
    {
        let mut item = manager.get_download(&download_id).await
            .ok_or("Download item not found")?;
        item.status = DownloadStatus::Completed;
        item.downloaded = total_bytes;
        item.total_size = total_bytes;
        item.speed = 0;
        item.completed_at = Some(chrono::Utc::now());
        manager.update_download(item).await;
        manager.remove_cancel_token(&download_id).await;
        manager.notify_slot_available();

        let _ = app.emit("download-progress", serde_json::json!({
            "id": download_id,
            "downloaded": total_bytes,
            "total_size": total_bytes,
            "speed": 0,
            "segments": [],
            "status": "Completed",
            "percent": 100.0,
        }));
    }

    println!("[HLS] Download completed: {} ({} segments, {} bytes)",
        save_filename, total_segments, total_bytes);

    Ok(())
}

async fn update_status(
    manager: &Arc<DownloadManager>,
    id: &str,
    status: DownloadStatus,
    error: Option<String>,
) {
    if let Some(mut item) = manager.get_download(id).await {
        item.status = status;
        item.error = error;
        manager.update_download(item).await;
    }
}

fn get_base_url(url: &str) -> String {
    if let Some(pos) = url.rfind('/') {
        url[..=pos].to_string()
    } else {
        url.to_string()
    }
}

fn resolve_segment_url(segment: &str, base_url: &str) -> String {
    if segment.starts_with("http://") || segment.starts_with("https://") {
        segment.to_string()
    } else if segment.starts_with('/') {
        // Absolute path — extract origin from base_url
        if let Ok(parsed) = url::Url::parse(base_url) {
            format!("{}://{}{}", parsed.scheme(), parsed.host_str().unwrap_or(""), segment)
        } else {
            format!("{}{}", base_url, segment)
        }
    } else {
        format!("{}{}", base_url, segment)
    }
}

/// Check if M3U8 content is a master playlist (contains variant stream info)
fn is_master_playlist(content: &str) -> bool {
    content.lines().any(|l| l.trim().starts_with("#EXT-X-STREAM-INF"))
}

fn parse_m3u8_segments(content: &str, base_url: &str) -> Vec<String> {
    let mut segments = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Skip lines that look like playlist references (not actual segments)
        let lower = trimmed.to_lowercase();
        if lower.ends_with(".m3u8") || lower.contains(".m3u8?") {
            continue;
        }
        // This is a segment URI
        segments.push(resolve_segment_url(trimmed, base_url));
    }

    segments
}

/// Parse a master playlist to find the highest-bandwidth variant playlist URL.
fn parse_master_playlist(content: &str, base_url: &str) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    let mut best_bandwidth = 0u64;
    let mut best_url: Option<String> = None;

    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("#EXT-X-STREAM-INF") {
            // Extract bandwidth
            let bandwidth = line
                .split(',')
                .find(|s| s.contains("BANDWIDTH"))
                .and_then(|s| s.split('=').last())
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0);

            // Next non-comment line is the URL
            if let Some(url_line) = lines.get(i + 1) {
                let trimmed = url_line.trim();
                if !trimmed.is_empty() && !trimmed.starts_with('#') {
                    if bandwidth >= best_bandwidth {
                        best_bandwidth = bandwidth;
                        best_url = Some(resolve_segment_url(trimmed, base_url));
                    }
                }
            }
        }
    }

    best_url
}
