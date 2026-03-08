use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentInfo {
    pub id: usize,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadItem {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub save_path: String,
    pub total_size: u64,
    pub downloaded: u64,
    pub status: DownloadStatus,
    pub speed: u64,
    pub segments: Vec<SegmentInfo>,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub resumable: bool,
}

impl DownloadItem {
    pub fn new(url: String, filename: String, save_path: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            url,
            filename,
            save_path,
            total_size: 0,
            downloaded: 0,
            status: DownloadStatus::Queued,
            speed: 0,
            segments: Vec::new(),
            created_at: Utc::now(),
            completed_at: None,
            error: None,
            resumable: false,
        }
    }

    pub fn progress_percent(&self) -> f64 {
        if self.total_size == 0 {
            return 0.0;
        }
        (self.downloaded as f64 / self.total_size as f64) * 100.0
    }

    pub fn full_path(&self) -> PathBuf {
        PathBuf::from(&self.save_path).join(&self.filename)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryRule {
    pub name: String,
    pub extensions: Vec<String>,
    pub subfolder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub download_dir: String,
    pub max_concurrent: usize,
    pub max_segments: usize,
    pub max_retries: usize,
    pub category_rules: Vec<CategoryRule>,
    pub api_token: String,
}

impl AppSettings {
    /// Given a filename, find the matching category rule and return
    /// `download_dir/subfolder`. Falls back to `download_dir` if no match.
    pub fn resolve_category_path(&self, filename: &str) -> String {
        let ext = filename
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase();

        if !ext.is_empty() {
            for rule in &self.category_rules {
                if rule.extensions.iter().any(|e| e.to_lowercase() == ext) {
                    let p = PathBuf::from(&self.download_dir).join(&rule.subfolder);
                    return p.to_string_lossy().to_string();
                }
            }
        }

        self.download_dir.clone()
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        let download_dir = dirs_next().unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "C:\\Downloads".to_string()
            } else {
                "/tmp/Downloads".to_string()
            }
        });
        Self {
            download_dir,
            max_concurrent: 3,
            max_segments: 8,
            max_retries: 3,
            category_rules: default_category_rules(),
            api_token: Uuid::new_v4().to_string(),
        }
    }
}

fn default_category_rules() -> Vec<CategoryRule> {
    vec![
        CategoryRule {
            name: "Compressed".into(),
            extensions: vec!["zip","rar","7z","tar","gz","bz2"].into_iter().map(String::from).collect(),
            subfolder: "Compressed".into(),
        },
        CategoryRule {
            name: "Documents".into(),
            extensions: vec!["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","odt"].into_iter().map(String::from).collect(),
            subfolder: "Documents".into(),
        },
        CategoryRule {
            name: "Images".into(),
            extensions: vec!["jpg","jpeg","png","gif","bmp","svg","webp","ico"].into_iter().map(String::from).collect(),
            subfolder: "Images".into(),
        },
        CategoryRule {
            name: "Video".into(),
            extensions: vec!["mp4","mkv","avi","mov","wmv","flv","webm","ts","m3u8"].into_iter().map(String::from).collect(),
            subfolder: "Video".into(),
        },
        CategoryRule {
            name: "Audio".into(),
            extensions: vec!["mp3","flac","wav","aac","ogg","wma","m4a"].into_iter().map(String::from).collect(),
            subfolder: "Audio".into(),
        },
        CategoryRule {
            name: "Programs".into(),
            extensions: vec!["exe","msi","deb","rpm","dmg","appimage"].into_iter().map(String::from).collect(),
            subfolder: "Programs".into(),
        },
    ]
}

fn dirs_next() -> Option<String> {
    // Windows
    if let Some(dir) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(dir).join("Downloads");
        return Some(p.to_string_lossy().to_string());
    }
    // Linux / macOS
    if let Some(dir) = std::env::var_os("HOME") {
        let p = PathBuf::from(dir).join("Downloads");
        return Some(p.to_string_lossy().to_string());
    }
    None
}

/// Helper to lock the std::sync::Mutex safely (handles poisoned state).
fn lock_db(db: &std::sync::Mutex<Option<Connection>>) -> std::sync::MutexGuard<'_, Option<Connection>> {
    db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct DownloadManager {
    pub downloads: Arc<Mutex<HashMap<String, DownloadItem>>>,
    pub settings: Arc<Mutex<AppSettings>>,
    pub cancel_tokens: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    /// Browser cookies forwarded by the extension, keyed by download ID.
    /// Used for authenticated downloads (e.g. private Google Drive files).
    pub download_cookies: Arc<Mutex<HashMap<String, String>>>,
    /// Notified when a download slot becomes available.
    pub slot_available: Arc<Notify>,
    db: Arc<std::sync::Mutex<Option<Connection>>>,
}

impl std::fmt::Debug for DownloadManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DownloadManager")
            .field("downloads", &self.downloads)
            .field("settings", &self.settings)
            .finish()
    }
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            downloads: Arc::new(Mutex::new(HashMap::new())),
            settings: Arc::new(Mutex::new(AppSettings::default())),
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
            download_cookies: Arc::new(Mutex::new(HashMap::new())),
            slot_available: Arc::new(Notify::new()),
            db: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Open (or create) the SQLite database and create the downloads table.
    pub fn init_db(&self, path: PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| e.to_string())?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS downloads (
                id          TEXT PRIMARY KEY,
                url         TEXT NOT NULL,
                filename    TEXT NOT NULL,
                save_path   TEXT NOT NULL,
                total_size  INTEGER NOT NULL DEFAULT 0,
                downloaded  INTEGER NOT NULL DEFAULT 0,
                status      TEXT NOT NULL DEFAULT 'Queued',
                segments    TEXT NOT NULL DEFAULT '[]',
                created_at  TEXT NOT NULL,
                completed_at TEXT,
                error       TEXT,
                resumable   INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS settings (
                id              INTEGER PRIMARY KEY CHECK (id = 1),
                download_dir    TEXT NOT NULL,
                max_concurrent  INTEGER NOT NULL DEFAULT 3,
                max_segments    INTEGER NOT NULL DEFAULT 8,
                max_retries     INTEGER NOT NULL DEFAULT 3,
                category_rules  TEXT NOT NULL DEFAULT '[]',
                api_token       TEXT NOT NULL DEFAULT ''
            );"
        ).map_err(|e| e.to_string())?;

        // Migration: add api_token column if missing (existing DBs)
        let _ = conn.execute_batch(
            "ALTER TABLE settings ADD COLUMN api_token TEXT NOT NULL DEFAULT '';"
        );

        let mut db = lock_db(&self.db);
        *db = Some(conn);
        Ok(())
    }

    /// Load all downloads from SQLite into memory.
    /// Items that were "Downloading" are reset to "Paused".
    pub async fn load_downloads(&self) {
        let items = {
            let db = lock_db(&self.db);
            let Some(conn) = db.as_ref() else { return };
            match Self::query_all_downloads(conn) {
                Ok(items) => items,
                Err(e) => {
                    eprintln!("[DB] Failed to load downloads: {}", e);
                    return;
                }
            }
        };

        let mut downloads = self.downloads.lock().await;
        for mut item in items {
            if item.status == DownloadStatus::Downloading {
                item.status = DownloadStatus::Paused;
                item.speed = 0;
            }
            downloads.insert(item.id.clone(), item);
        }
    }

    /// Load settings from SQLite. Falls back to defaults if not found.
    pub async fn load_settings(&self) {
        let loaded = {
            let db = lock_db(&self.db);
            let Some(conn) = db.as_ref() else { return };
            conn.query_row(
                "SELECT download_dir, max_concurrent, max_segments, max_retries, category_rules, api_token
                 FROM settings WHERE id = 1",
                [],
                |row| {
                    let rules_json: String = row.get(4)?;
                    let token: String = row.get(5)?;
                    Ok(AppSettings {
                        download_dir: row.get(0)?,
                        max_concurrent: row.get::<_, i64>(1)? as usize,
                        max_segments: row.get::<_, i64>(2)? as usize,
                        max_retries: row.get::<_, i64>(3)? as usize,
                        category_rules: serde_json::from_str(&rules_json).unwrap_or_default(),
                        api_token: token,
                    })
                },
            ).ok()
        };

        if let Some(mut loaded) = loaded {
            // Generate a token if empty (first run or migration)
            if loaded.api_token.is_empty() {
                loaded.api_token = Uuid::new_v4().to_string();
            }
            let mut settings = self.settings.lock().await;
            *settings = loaded;
        }

        // Persist token if it was just generated
        self.save_settings().await;
    }

    /// Persist current settings to SQLite.
    pub async fn save_settings(&self) {
        let settings = self.settings.lock().await;
        let rules_json = serde_json::to_string(&settings.category_rules)
            .unwrap_or_else(|_| "[]".into());

        let db = lock_db(&self.db);
        let Some(conn) = db.as_ref() else { return };
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings
                (id, download_dir, max_concurrent, max_segments, max_retries, category_rules, api_token)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                settings.download_dir,
                settings.max_concurrent as i64,
                settings.max_segments as i64,
                settings.max_retries as i64,
                rules_json,
                settings.api_token,
            ],
        );
    }

    fn query_all_downloads(conn: &Connection) -> Result<Vec<DownloadItem>, String> {
        let mut stmt = conn.prepare(
            "SELECT id, url, filename, save_path, total_size, downloaded,
                    status, segments, created_at, completed_at, error, resumable
             FROM downloads"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(6)?;
            let segments_json: String = row.get(7)?;
            let created_at_str: String = row.get(8)?;
            let completed_at_str: Option<String> = row.get(9)?;
            let resumable_int: i32 = row.get(11)?;

            Ok(DownloadItem {
                id: row.get(0)?,
                url: row.get(1)?,
                filename: row.get(2)?,
                save_path: row.get(3)?,
                total_size: row.get::<_, i64>(4)? as u64,
                downloaded: row.get::<_, i64>(5)? as u64,
                status: str_to_status(&status_str),
                speed: 0,
                segments: serde_json::from_str(&segments_json).unwrap_or_default(),
                created_at: DateTime::parse_from_rfc3339(&created_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                completed_at: completed_at_str.and_then(|s|
                    DateTime::parse_from_rfc3339(&s).ok().map(|dt| dt.with_timezone(&Utc))
                ),
                error: row.get(10)?,
                resumable: resumable_int != 0,
            })
        }).map_err(|e| e.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            match row {
                Ok(item) => items.push(item),
                Err(e) => eprintln!("[DB] Skipping corrupt row: {}", e),
            }
        }
        Ok(items)
    }

    /// Upsert a single download row in SQLite.
    fn db_save(&self, item: &DownloadItem) {
        let db = lock_db(&self.db);
        let Some(conn) = db.as_ref() else { return };
        let segments_json = serde_json::to_string(&item.segments).unwrap_or_else(|_| "[]".into());
        let completed_at = item.completed_at.map(|dt| dt.to_rfc3339());

        let _ = conn.execute(
            "INSERT OR REPLACE INTO downloads
                (id, url, filename, save_path, total_size, downloaded, status,
                 segments, created_at, completed_at, error, resumable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                item.id,
                item.url,
                item.filename,
                item.save_path,
                item.total_size as i64,
                item.downloaded as i64,
                status_to_str(&item.status),
                segments_json,
                item.created_at.to_rfc3339(),
                completed_at,
                item.error,
                item.resumable as i32,
            ],
        );
    }

    /// Delete a single download row from SQLite.
    fn db_delete(&self, id: &str) {
        let db = lock_db(&self.db);
        let Some(conn) = db.as_ref() else { return };
        let _ = conn.execute("DELETE FROM downloads WHERE id = ?1", params![id]);
    }

    pub async fn add_download(&self, url: String, filename: String, save_path: String) -> DownloadItem {
        let item = DownloadItem::new(url, filename, save_path);
        let mut downloads = self.downloads.lock().await;
        downloads.insert(item.id.clone(), item.clone());
        drop(downloads);
        self.db_save(&item);
        item
    }

    pub async fn get_downloads(&self) -> Vec<DownloadItem> {
        let downloads = self.downloads.lock().await;
        let mut items: Vec<DownloadItem> = downloads.values().cloned().collect();
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
    }

    pub async fn get_download(&self, id: &str) -> Option<DownloadItem> {
        let downloads = self.downloads.lock().await;
        downloads.get(id).cloned()
    }

    /// Update a download item in memory. Persists to SQLite only when
    /// the status is NOT `Downloading` (to avoid I/O on every progress tick).
    pub async fn update_download(&self, item: DownloadItem) {
        let should_save = !matches!(item.status, DownloadStatus::Downloading);
        let mut downloads = self.downloads.lock().await;
        downloads.insert(item.id.clone(), item.clone());
        drop(downloads);
        if should_save {
            self.db_save(&item);
        }
    }

    pub async fn remove_download(&self, id: &str) {
        let mut downloads = self.downloads.lock().await;
        downloads.remove(id);
        drop(downloads);
        self.db_delete(id);
    }

    pub async fn set_cancel_token(&self, id: &str, sender: tokio::sync::watch::Sender<bool>) {
        let mut tokens = self.cancel_tokens.lock().await;
        tokens.insert(id.to_string(), sender);
    }

    pub async fn cancel_download(&self, id: &str) -> bool {
        let tokens = self.cancel_tokens.lock().await;
        if let Some(sender) = tokens.get(id) {
            let _ = sender.send(true);
            return true;
        }
        false
    }

    pub async fn remove_cancel_token(&self, id: &str) {
        let mut tokens = self.cancel_tokens.lock().await;
        tokens.remove(id);
    }

    /// Count how many downloads are currently in Downloading status.
    pub async fn count_active_downloads(&self) -> usize {
        let downloads = self.downloads.lock().await;
        downloads.values().filter(|d| d.status == DownloadStatus::Downloading).count()
    }

    /// Wait until there is a free download slot (active < max_concurrent).
    /// Returns Err if the download was cancelled while waiting.
    pub async fn wait_for_download_slot(&self, download_id: &str) -> Result<(), String> {
        loop {
            let active = self.count_active_downloads().await;
            let max = self.settings.lock().await.max_concurrent;
            if active < max {
                return Ok(());
            }

            // Check if cancelled while waiting in queue
            if let Some(item) = self.get_download(download_id).await {
                if item.status == DownloadStatus::Cancelled
                    || item.status == DownloadStatus::Paused
                {
                    return Err("Download cancelled while queued".into());
                }
            } else {
                return Err("Download removed while queued".into());
            }

            // Wait for a slot to become available instead of busy-polling
            self.slot_available.notified().await;
        }
    }

    /// Notify waiters that a download slot may have become available.
    pub fn notify_slot_available(&self) {
        self.slot_available.notify_waiters();
    }
}

fn status_to_str(s: &DownloadStatus) -> &'static str {
    match s {
        DownloadStatus::Queued => "Queued",
        DownloadStatus::Downloading => "Downloading",
        DownloadStatus::Paused => "Paused",
        DownloadStatus::Completed => "Completed",
        DownloadStatus::Failed => "Failed",
        DownloadStatus::Cancelled => "Cancelled",
    }
}

fn str_to_status(s: &str) -> DownloadStatus {
    match s {
        "Downloading" => DownloadStatus::Downloading,
        "Paused" => DownloadStatus::Paused,
        "Completed" => DownloadStatus::Completed,
        "Failed" => DownloadStatus::Failed,
        "Cancelled" => DownloadStatus::Cancelled,
        _ => DownloadStatus::Queued,
    }
}
