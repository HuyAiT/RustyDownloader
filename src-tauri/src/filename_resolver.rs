use percent_encoding::percent_decode_str;

/// Normalize a Google Drive URL to ensure direct download with `confirm=t`
/// (bypasses the virus scan warning page for large files).
/// Non-Google-Drive URLs are returned unchanged.
pub fn normalize_gdrive_url(url: &str) -> String {
    if !url.contains("drive.google.com") && !url.contains("docs.google.com") {
        return url.to_string();
    }

    // Extract file ID from various URL formats
    if let Some(id) = extract_gdrive_file_id(url) {
        return format!(
            "https://drive.google.com/uc?export=download&confirm=t&id={}",
            id
        );
    }

    // Fallback: if it's already a /uc URL, just append confirm=t
    if url.contains("drive.google.com/uc") && !url.contains("confirm=") {
        if url.contains('?') {
            return format!("{}&confirm=t", url);
        } else {
            return format!("{}?confirm=t", url);
        }
    }

    url.to_string()
}

fn extract_gdrive_file_id(url: &str) -> Option<&str> {
    // Format: /file/d/FILE_ID/...
    if let Some(start) = url.find("/file/d/") {
        let after = &url[start + 8..];
        let end = after.find(|c| c == '/' || c == '?').unwrap_or(after.len());
        if end > 0 {
            return Some(&after[..end]);
        }
    }

    // Format: id=FILE_ID (in query string)
    if let Some(start) = url.find("id=") {
        let after = &url[start + 3..];
        let end = after.find('&').unwrap_or(after.len());
        if end > 0 {
            return Some(&after[..end]);
        }
    }

    None
}

/// Resolve a filename from an HTTP response, with multiple fallback strategies.
///
/// Priority:
/// 1. Content-Disposition header (filename* then filename)
/// 2. Final URL after redirects (path segment)
/// 3. Original URL (path segment)
/// 4. Fallback: "download"
///
/// After resolving, ensures the file has an extension using Content-Type if needed.
pub fn resolve_filename(response: &reqwest::Response, original_url: &str) -> String {
    let headers = response.headers();

    // 1. Try Content-Disposition header
    if let Some(cd) = headers.get(reqwest::header::CONTENT_DISPOSITION) {
        // to_str() only works for ASCII. For non-ASCII filenames (e.g. Japanese, Vietnamese),
        // fall back to lossy UTF-8 conversion from raw bytes.
        let cd_str = cd.to_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|_| String::from_utf8_lossy(cd.as_bytes()).to_string());

        if let Some(name) = parse_content_disposition(&cd_str) {
            let name = sanitize_filename(&name);
            if !name.is_empty() && name != "download" {
                return ensure_extension(name, headers);
            }
        }
    }

    // 2. Try final URL after redirects
    let final_url = response.url().as_str();
    if let Some(name) = extract_filename_from_url(final_url) {
        let name = sanitize_filename(&name);
        if !name.is_empty() && name != "download" {
            return ensure_extension(name, headers);
        }
    }

    // 3. Try original URL
    if final_url != original_url {
        if let Some(name) = extract_filename_from_url(original_url) {
            let name = sanitize_filename(&name);
            if !name.is_empty() && name != "download" {
                return ensure_extension(name, headers);
            }
        }
    }

    // 4. Fallback
    ensure_extension("download".to_string(), headers)
}

/// Parse the Content-Disposition header value and extract the filename.
///
/// Handles:
/// - `filename*=UTF-8''encoded%20name.pdf` (RFC 5987)
/// - `filename*=utf-8''encoded%20name.pdf` (case-insensitive)
/// - `filename="name.pdf"` (quoted)
/// - `filename=name.pdf` (unquoted)
fn parse_content_disposition(header: &str) -> Option<String> {
    // First, try filename* (RFC 5987 extended notation) — highest priority
    if let Some(name) = extract_rfc5987_filename(header) {
        return Some(name);
    }

    // Then try standard filename parameter
    if let Some(name) = extract_standard_filename(header) {
        return Some(name);
    }

    None
}

/// Extract filename from RFC 5987 `filename*` parameter.
/// Format: `filename*=charset'language'value`
/// Example: `filename*=UTF-8''My%20Report%20%28Final%29.pdf`
fn extract_rfc5987_filename(header: &str) -> Option<String> {
    // Case-insensitive search for "filename*="
    let lower = header.to_lowercase();
    let idx = lower.find("filename*=")?;
    let after = &header[idx + "filename*=".len()..];

    // Find the end of the value (semicolon or end of string)
    let value = after.split(';').next().unwrap_or(after).trim();

    // Format: charset'language'encoded_value
    // We find the second single quote to split
    let mut parts = value.splitn(3, '\'');
    let _charset = parts.next()?; // e.g., "UTF-8"
    let _language = parts.next()?; // e.g., "" or "en"
    let encoded = parts.next()?;

    // Percent-decode the value
    let decoded = percent_decode_str(encoded).decode_utf8().ok()?.to_string();

    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

/// Extract filename from standard `filename=` parameter.
/// Handles both quoted and unquoted values.
fn extract_standard_filename(header: &str) -> Option<String> {
    let lower = header.to_lowercase();

    // Make sure we don't match "filename*=" by checking for plain "filename="
    // We look for "filename=" that is NOT preceded by "*"
    let mut search_from = 0;
    loop {
        let idx = lower[search_from..].find("filename=")?;
        let abs_idx = search_from + idx;

        // Check that this is not "filename*="
        if abs_idx > 0 && &header[abs_idx - 1..abs_idx] == "*" {
            search_from = abs_idx + "filename=".len();
            continue;
        }

        let after = &header[abs_idx + "filename=".len()..];
        let after = after.trim();

        let filename = if after.starts_with('"') {
            // Quoted filename: filename="name.pdf"
            let end_quote = after[1..].find('"').map(|i| i + 1)?;
            &after[1..end_quote]
        } else {
            // Unquoted: filename=name.pdf
            // Ends at semicolon, space, or end of string
            after.split(';').next().unwrap_or(after).trim()
        };

        if filename.is_empty() {
            return None;
        }

        // Percent-decode in case the filename is URL-encoded
        let decoded = percent_decode_str(filename)
            .decode_utf8()
            .unwrap_or(std::borrow::Cow::Borrowed(filename))
            .to_string();

        return Some(decoded);
    }
}

/// Extract a filename from a URL's path segment.
fn extract_filename_from_url(url: &str) -> Option<String> {
    // Remove the query/fragment parts
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split('#').next().unwrap_or(path);

    // Get last path segment
    let segment = path.split('/').last()?;

    if segment.is_empty() {
        return None;
    }

    // Percent-decode the segment
    let decoded = percent_decode_str(segment)
        .decode_utf8()
        .unwrap_or(std::borrow::Cow::Borrowed(segment))
        .to_string();

    Some(decoded)
}

/// Ensure the filename has a proper file extension.
/// If it already has one, keep it. Otherwise, guess from Content-Type.
fn ensure_extension(filename: String, headers: &reqwest::header::HeaderMap) -> String {
    // Check if the filename already has an extension
    if let Some(dot_pos) = filename.rfind('.') {
        let ext = &filename[dot_pos + 1..];
        // If there's a non-empty extension that looks valid (no spaces, reasonable length)
        if !ext.is_empty() && ext.len() <= 10 && !ext.contains(' ') {
            return filename;
        }
    }

    // Try to get extension from Content-Type header
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Extract the MIME type (before any parameters like charset)
    let mime = content_type.split(';').next().unwrap_or("").trim();

    if let Some(ext) = mime_to_extension(mime) {
        format!("{}.{}", filename, ext)
    } else {
        filename
    }
}

/// Map common MIME types to file extensions.
fn mime_to_extension(mime: &str) -> Option<&'static str> {
    match mime.to_lowercase().as_str() {
        // Documents
        "application/pdf" => Some("pdf"),
        "application/msword" => Some("doc"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.ms-excel" => Some("xls"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.ms-powerpoint" => Some("ppt"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        "application/rtf" => Some("rtf"),
        "text/plain" => Some("txt"),
        "text/csv" => Some("csv"),
        "text/html" => Some("html"),
        "text/css" => Some("css"),
        "text/javascript" | "application/javascript" => Some("js"),
        "application/json" => Some("json"),
        "application/xml" | "text/xml" => Some("xml"),

        // Archives
        "application/zip" | "application/x-zip-compressed" => Some("zip"),
        "application/x-rar-compressed" | "application/vnd.rar" => Some("rar"),
        "application/x-7z-compressed" => Some("7z"),
        "application/gzip" | "application/x-gzip" => Some("gz"),
        "application/x-tar" => Some("tar"),
        "application/x-bzip2" => Some("bz2"),
        "application/x-xz" => Some("xz"),

        // Images
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        "image/avif" => Some("avif"),

        // Video
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/x-msvideo" => Some("avi"),
        "video/x-matroska" => Some("mkv"),
        "video/quicktime" => Some("mov"),
        "video/x-flv" => Some("flv"),
        "video/x-ms-wmv" => Some("wmv"),
        "video/mpeg" => Some("mpeg"),

        // Audio
        "audio/mpeg" => Some("mp3"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/ogg" => Some("ogg"),
        "audio/flac" | "audio/x-flac" => Some("flac"),
        "audio/aac" => Some("aac"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/webm" => Some("weba"),

        // Executables & installers
        "application/x-msdownload" | "application/x-dosexec" => Some("exe"),
        "application/x-msi" => Some("msi"),
        "application/vnd.debian.binary-package" => Some("deb"),
        "application/x-rpm" => Some("rpm"),
        "application/x-apple-diskimage" => Some("dmg"),
        "application/vnd.android.package-archive" => Some("apk"),

        // Fonts
        "font/woff" => Some("woff"),
        "font/woff2" => Some("woff2"),
        "font/ttf" => Some("ttf"),
        "font/otf" => Some("otf"),

        // ISO / disk images
        "application/x-iso9660-image" => Some("iso"),

        // Generic binary — don't add extension, user might know what it is
        "application/octet-stream" => None,

        _ => None,
    }
}

/// Sanitize a filename by removing invalid filesystem characters.
fn sanitize_filename(name: &str) -> String {
    let name = name.trim();

    // Remove characters invalid on Windows/Linux filesystems
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();

    // Remove leading/trailing dots and spaces (Windows doesn't like these)
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c == ' ');

    // If somehow empty after sanitization
    if cleaned.is_empty() {
        return "download".to_string();
    }

    // Check for Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    let stem = cleaned.split('.').next().unwrap_or(cleaned);
    let upper = stem.to_uppercase();
    let is_reserved = matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
        | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
        | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    );
    if is_reserved {
        return format!("_{}", cleaned);
    }

    cleaned.to_string()
}

/// Check if a filename is a generic/placeholder name that should be replaced.
pub fn is_generic_filename(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    matches!(stem, "download" | "uc" | "file" | "export" | "get" | "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_content_disposition_quoted() {
        let header = r#"attachment; filename="report.pdf""#;
        assert_eq!(
            parse_content_disposition(header),
            Some("report.pdf".to_string())
        );
    }

    #[test]
    fn test_parse_content_disposition_unquoted() {
        let header = "attachment; filename=report.pdf";
        assert_eq!(
            parse_content_disposition(header),
            Some("report.pdf".to_string())
        );
    }

    #[test]
    fn test_parse_content_disposition_rfc5987() {
        let header = "attachment; filename*=UTF-8''My%20Report.pdf";
        assert_eq!(
            parse_content_disposition(header),
            Some("My Report.pdf".to_string())
        );
    }

    #[test]
    fn test_parse_content_disposition_both() {
        // When both filename* and filename are present, filename* takes priority
        let header = r#"attachment; filename="fallback.pdf"; filename*=UTF-8''correct%20name.pdf"#;
        assert_eq!(
            parse_content_disposition(header),
            Some("correct name.pdf".to_string())
        );
    }

    #[test]
    fn test_extract_filename_from_url_simple() {
        let url = "https://example.com/files/document.pdf";
        assert_eq!(
            extract_filename_from_url(url),
            Some("document.pdf".to_string())
        );
    }

    #[test]
    fn test_extract_filename_from_url_with_query() {
        let url = "https://example.com/files/document.pdf?token=abc123";
        assert_eq!(
            extract_filename_from_url(url),
            Some("document.pdf".to_string())
        );
    }

    #[test]
    fn test_extract_filename_from_url_encoded() {
        let url = "https://example.com/files/my%20file.pdf";
        assert_eq!(
            extract_filename_from_url(url),
            Some("my file.pdf".to_string())
        );
    }

    #[test]
    fn test_sanitize_filename_invalid_chars() {
        assert_eq!(sanitize_filename("file<>name.pdf"), "file__name.pdf");
        assert_eq!(sanitize_filename("file:name.pdf"), "file_name.pdf");
    }

    #[test]
    fn test_sanitize_filename_empty() {
        assert_eq!(sanitize_filename("..."), "download");
        assert_eq!(sanitize_filename(""), "download");
    }

    #[test]
    fn test_mime_to_extension() {
        assert_eq!(mime_to_extension("application/pdf"), Some("pdf"));
        assert_eq!(mime_to_extension("image/jpeg"), Some("jpg"));
        assert_eq!(mime_to_extension("application/octet-stream"), None);
        assert_eq!(mime_to_extension("application/zip"), Some("zip"));
        assert_eq!(mime_to_extension("video/mp4"), Some("mp4"));
    }

    #[test]
    fn test_google_drive_url_fallback() {
        // Google Drive URLs produce "download" from the path
        let url = "https://drive.google.com/uc?export=download&id=1234567890";
        let name = extract_filename_from_url(url).unwrap();
        assert_eq!(name, "uc"); // Should fall through to Content-Disposition
    }
}
