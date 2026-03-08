use crate::download_manager::{CategoryRule, DownloadManager};
use crate::downloader;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn add_download(
    app: AppHandle,
    manager: State<'_, Arc<DownloadManager>>,
    url: String,
    filename: String,
    save_path: String,
) -> Result<serde_json::Value, String> {
    // If save_path is empty, auto-resolve from category rules
    let resolved_path = if save_path.is_empty() {
        let settings = manager.settings.lock().await;
        settings.resolve_category_path(&filename)
    } else {
        save_path
    };

    let item = manager.add_download(url, filename, resolved_path).await;
    let item_json = serde_json::to_value(&item).map_err(|e| e.to_string())?;

    // Start download in background
    let mgr = manager.inner().clone();
    let download_id = item.id.clone();
    tokio::spawn(async move {
        if let Err(e) = downloader::start_download(app, mgr, download_id.clone()).await {
            eprintln!("Download error for {}: {}", download_id, e);
        }
    });

    Ok(item_json)
}

#[tauri::command]
pub async fn pause_download(
    manager: State<'_, Arc<DownloadManager>>,
    id: String,
) -> Result<(), String> {
    // Cancel the current download task
    manager.cancel_download(&id).await;

    // Update status to Paused
    if let Some(mut item) = manager.get_download(&id).await {
        item.status = crate::download_manager::DownloadStatus::Paused;
        item.speed = 0;
        manager.update_download(item).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_download(
    app: AppHandle,
    manager: State<'_, Arc<DownloadManager>>,
    id: String,
) -> Result<(), String> {
    if let Some(item) = manager.get_download(&id).await {
        if item.status == crate::download_manager::DownloadStatus::Paused
            || item.status == crate::download_manager::DownloadStatus::Failed
        {
            let mgr = manager.inner().clone();
            let download_id = id.clone();
            tokio::spawn(async move {
                if let Err(e) = downloader::start_download(app, mgr, download_id.clone()).await {
                    eprintln!("Resume error for {}: {}", download_id, e);
                }
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_download(
    manager: State<'_, Arc<DownloadManager>>,
    id: String,
) -> Result<(), String> {
    manager.cancel_download(&id).await;

    if let Some(mut item) = manager.get_download(&id).await {
        item.status = crate::download_manager::DownloadStatus::Cancelled;
        item.speed = 0;
        manager.update_download(item).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_download(
    manager: State<'_, Arc<DownloadManager>>,
    id: String,
) -> Result<(), String> {
    manager.cancel_download(&id).await;
    manager.remove_download(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn get_downloads(
    manager: State<'_, Arc<DownloadManager>>,
) -> Result<serde_json::Value, String> {
    let items = manager.get_downloads().await;
    serde_json::to_value(&items).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_settings(
    manager: State<'_, Arc<DownloadManager>>,
) -> Result<serde_json::Value, String> {
    let settings = manager.settings.lock().await;
    serde_json::to_value(&*settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_settings(
    manager: State<'_, Arc<DownloadManager>>,
    download_dir: String,
    max_concurrent: usize,
    max_segments: usize,
    max_retries: usize,
    category_rules: Vec<CategoryRule>,
) -> Result<(), String> {
    let mut settings = manager.settings.lock().await;
    settings.download_dir = download_dir;
    settings.max_concurrent = max_concurrent;
    settings.max_segments = max_segments;
    settings.max_retries = max_retries;
    settings.category_rules = category_rules;
    drop(settings);
    manager.save_settings().await;
    Ok(())
}

#[tauri::command]
pub async fn get_category_rules(
    manager: State<'_, Arc<DownloadManager>>,
) -> Result<serde_json::Value, String> {
    let settings = manager.settings.lock().await;
    serde_json::to_value(&settings.category_rules).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resolve_save_path(
    manager: State<'_, Arc<DownloadManager>>,
    filename: String,
) -> Result<String, String> {
    let settings = manager.settings.lock().await;
    Ok(settings.resolve_category_path(&filename))
}

#[tauri::command]
pub async fn get_file_info(
    url: String,
) -> Result<serde_json::Value, String> {
    let url = crate::filename_resolver::normalize_gdrive_url(&url);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .cookie_store(true)
        .build()
        .map_err(|e| e.to_string())?;

    let head_resp = client
        .head(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    let content_length = head_resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let content_type = head_resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let accept_ranges = head_resp
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "bytes")
        .unwrap_or(false);

    // Try to resolve filename from HEAD response first
    let filename = crate::filename_resolver::resolve_filename(&head_resp, &url);

    // If HEAD didn't give us a real filename, try a plain GET request.
    // Many servers (e.g. Google Drive) only return Content-Disposition on GET, not HEAD.
    // We only read headers — dropping the response cancels the body download.
    let filename = if crate::filename_resolver::is_generic_filename(&filename) {
        match client.get(&url).send().await {
            Ok(get_resp) => {
                let name = crate::filename_resolver::resolve_filename(&get_resp, &url);
                if crate::filename_resolver::is_generic_filename(&name) { filename } else { name }
            }
            Err(_) => filename,
        }
    } else {
        filename
    };

    Ok(serde_json::json!({
        "filename": filename,
        "size": content_length,
        "content_type": content_type,
        "resumable": accept_ranges,
    }))
}

#[tauri::command]
pub async fn get_api_token(
    manager: State<'_, Arc<DownloadManager>>,
) -> Result<String, String> {
    let settings = manager.settings.lock().await;
    Ok(settings.api_token.clone())
}

#[tauri::command]
pub async fn check_ffmpeg() -> Result<bool, String> {
    match tokio::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .await
    {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn convert_to_mp4(
    manager: State<'_, Arc<DownloadManager>>,
    id: String,
) -> Result<String, String> {
    let item = manager
        .get_download(&id)
        .await
        .ok_or("Download not found")?;

    if item.status != crate::download_manager::DownloadStatus::Completed {
        return Err("Download is not completed yet".into());
    }

    let input_path = item.full_path();
    if !input_path.exists() {
        return Err(format!("File not found: {}", input_path.display()));
    }

    // Only allow .ts files to be converted
    let ext = input_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "ts" {
        return Err("Only .ts files can be converted to .mp4".into());
    }

    // Build output path: same name but .mp4
    let output_path = input_path.with_extension("mp4");

    let input_str = input_path.to_str()
        .ok_or_else(|| "Input file path contains invalid characters".to_string())?;
    let output_str = output_path.to_str()
        .ok_or_else(|| "Output file path contains invalid characters".to_string())?;

    // Run ffmpeg conversion
    let output = tokio::process::Command::new("ffmpeg")
        .args([
            "-i",
            input_str,
            "-c",
            "copy", // fast copy, no re-encoding
            "-y",   // overwrite
            output_str,
        ])
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "ffmpeg not found. Please install ffmpeg and add it to your PATH.".to_string()
            } else {
                format!("Failed to run ffmpeg: {}", e)
            }
        })?;

    if output.status.success() {
        let mp4_path = output_path.to_string_lossy().to_string();
        println!("[Convert] Successfully converted to: {}", mp4_path);
        Ok(mp4_path)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("ffmpeg conversion failed: {}", stderr))
    }
}
