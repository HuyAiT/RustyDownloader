use crate::download_manager::DownloadManager;
use crate::downloader;
use crate::hls_downloader;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use tauri::AppHandle;

/// Maximum request body size (1 MB). Rejects anything larger to prevent abuse.
const MAX_BODY_SIZE: usize = 1_048_576;

/// Maximum number of HTTP headers to accept per request.
const MAX_HEADER_COUNT: usize = 64;

/// Maximum length of a single header line (8 KB).
const MAX_HEADER_LINE: usize = 8_192;

/// Starts a tiny HTTP server on localhost:7890 to receive download requests
/// from the browser extension.
pub fn start_extension_server(app: AppHandle, manager: Arc<DownloadManager>) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:7890") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to start extension server: {}", e);
                return;
            }
        };
        println!("[Extension Server] Listening on http://127.0.0.1:7890");

        for stream in listener.incoming() {
            let stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };

            let app = app.clone();
            let manager = manager.clone();

            std::thread::spawn(move || {
                if let Err(e) = handle_request(stream, app, manager) {
                    eprintln!("[Extension Server] Error: {}", e);
                }
            });
        }
    });
}

fn handle_request(
    mut stream: std::net::TcpStream,
    app: AppHandle,
    manager: Arc<DownloadManager>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);

    // Read request line
    let mut request_line = String::new();
    reader.read_line(&mut request_line).map_err(|e| e.to_string())?;

    // Read headers
    let mut content_length: usize = 0;
    let mut auth_token = String::new();
    let mut origin = String::new();
    let is_options = request_line.starts_with("OPTIONS");
    let mut header_count = 0;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).map_err(|e| e.to_string())?;
        let trimmed = header.trim();
        if trimmed.is_empty() {
            break;
        }
        header_count += 1;
        if header_count > MAX_HEADER_COUNT || trimmed.len() > MAX_HEADER_LINE {
            let body = r#"{"error":"Request headers too large"}"#;
            let response = format!(
                "HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(), body
            );
            stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
            return Ok(());
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let key_lower = key.trim().to_lowercase();
            let value = value.trim();
            match key_lower.as_str() {
                "content-length" => {
                    content_length = value.parse().unwrap_or(0);
                }
                "x-auth-token" => {
                    auth_token = value.to_string();
                }
                "origin" => {
                    origin = value.to_string();
                }
                _ => {}
            }
        }
    }

    // CORS headers — restrict to browser extension origins and localhost
    let allowed_origin = if origin.starts_with("chrome-extension://")
        || origin.starts_with("moz-extension://")
        || origin.starts_with("http://localhost")
        || origin.starts_with("http://127.0.0.1")
    {
        origin.as_str()
    } else if origin.is_empty() {
        // No Origin header (e.g. curl, direct requests) — allow
        "*"
    } else {
        // Unknown origin — deny by not matching
        "null"
    };
    let cors_headers = format!(
        "Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-Auth-Token\r\n",
        allowed_origin
    );

    // Handle OPTIONS (preflight)
    if is_options {
        let response = format!("HTTP/1.1 204 No Content\r\n{}\r\n", cors_headers);
        stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Handle GET /ping — health check
    if request_line.starts_with("GET /ping") {
        let body = r#"{"status":"ok","app":"RustyDownloader"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n{}",
            cors_headers,
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // ---- Guards for POST endpoints ----

    // Body size limit
    if content_length > MAX_BODY_SIZE {
        let body = r#"{"error":"Request body too large"}"#;
        let response = format!(
            "HTTP/1.1 413 Payload Too Large\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n{}",
            cors_headers, body.len(), body
        );
        stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Auth token validation for POST endpoints
    if request_line.starts_with("POST ") {
        let expected_token = tauri::async_runtime::block_on(async {
            let settings = manager.settings.lock().await;
            settings.api_token.clone()
        });

        if auth_token != expected_token {
            let body = r#"{"error":"Unauthorized"}"#;
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n{}",
                cors_headers, body.len(), body
            );
            stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    // Handle POST /download-hls (HLS/M3U8 segmented video download)
    if request_line.starts_with("POST /download-hls") {
        let mut body = vec![0u8; content_length];
        reader.read_exact(&mut body).map_err(|e| e.to_string())?;
        let body_str = String::from_utf8_lossy(&body);

        #[derive(serde::Deserialize)]
        struct HlsRequest {
            url: String,
            filename: Option<String>,
            segments: Option<Vec<String>>,
        }

        let req: HlsRequest =
            serde_json::from_str(&body_str).map_err(|e| format!("JSON parse error: {}", e))?;

        let filename = req.filename.unwrap_or_default();
        let segments = req.segments.unwrap_or_default();
        let mgr = manager.clone();
        let app2 = app.clone();

        // Start HLS download in background
        tauri::async_runtime::spawn(async move {
            if let Err(e) = hls_downloader::download_hls(app2, mgr, req.url, filename, segments).await {
                eprintln!("[HLS] Download error: {}", e);
            }
        });

        let resp_body = r#"{"status":"ok","message":"HLS download started"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n{}",
            cors_headers,
            resp_body.len(),
            resp_body
        );
        stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Handle POST /download
    if request_line.starts_with("POST /download") {
        let mut body = vec![0u8; content_length];
        reader.read_exact(&mut body).map_err(|e| e.to_string())?;
        let body_str = String::from_utf8_lossy(&body);

        #[derive(serde::Deserialize)]
        struct DownloadRequest {
            url: String,
            filename: Option<String>,
            cookies: Option<String>,
        }

        let req: DownloadRequest =
            serde_json::from_str(&body_str).map_err(|e| format!("JSON parse error: {}", e))?;

        let filename = req.filename.unwrap_or_default();

        // Add download using tauri's async runtime (works from any thread)
        let mgr = manager.clone();
        let app2 = app.clone();

        let item = tauri::async_runtime::block_on(async {
            let settings = mgr.settings.lock().await;
            let save_path = settings.resolve_category_path(&filename);
            drop(settings);

            let item = mgr.add_download(req.url, filename, save_path).await;

            // Store browser cookies for authenticated downloads (e.g. Google Drive)
            if let Some(cookies) = req.cookies {
                if !cookies.is_empty() {
                    let mut cookie_store = mgr.download_cookies.lock().await;
                    cookie_store.insert(item.id.clone(), cookies);
                }
            }

            // Start download in background
            let download_id = item.id.clone();
            let mgr2 = mgr.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = downloader::start_download(app2, mgr2, download_id.clone()).await {
                    eprintln!("Download error: {}", e);
                }
            });

            item
        });

        // Emit event to frontend to refresh list
        let _ = tauri::Emitter::emit(&app, "download-added", &item);

        let resp_body = serde_json::to_string(&item).unwrap_or_default();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n{}",
            cors_headers,
            resp_body.len(),
            resp_body
        );
        stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // 404 for everything else
    let body = r#"{"error":"Not Found"}"#;
    let response = format!(
        "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n{}",
        cors_headers,
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}
