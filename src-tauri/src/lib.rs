mod commands;
mod download_manager;
mod downloader;
mod extension_server;
mod filename_resolver;
mod hls_downloader;
mod tray;

use download_manager::DownloadManager;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = Arc::new(DownloadManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(manager.clone())
        .setup(move |app| {
            // Set up SQLite database for download persistence
            let data_dir = app.path().app_data_dir().map_err(|e| {
                eprintln!("[Init] Failed to resolve app data dir: {}", e);
                e
            })?;
            let db_path = data_dir.join("downloads.db");
            manager.init_db(db_path).expect("Failed to init database");
            let mgr = manager.clone();
            tauri::async_runtime::block_on(async {
                mgr.load_settings().await;
                mgr.load_downloads().await;
            });

            // Start extension server for browser integration
            extension_server::start_extension_server(app.handle().clone(), manager.clone());

            // Create system tray icon with menu
            tray::create_tray(app.handle())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept close request: hide the window instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_download,
            commands::pause_download,
            commands::resume_download,
            commands::cancel_download,
            commands::remove_download,
            commands::get_downloads,
            commands::get_settings,
            commands::update_settings,
            commands::get_file_info,
            commands::get_category_rules,
            commands::resolve_save_path,
            commands::check_ffmpeg,
            commands::convert_to_mp4,
            commands::get_api_token,
            commands::regenerate_api_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
