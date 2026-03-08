# RustyDownloader

A fast, lightweight download manager built with Rust and Tauri.

## Features

- **Multi-segment parallel downloading** — up to 16 segments with HTTP Range requests
- **HLS/M3U8 video stream downloading** — captures and downloads streaming videos
- **Google Drive support** — auto-handles virus scan confirmation pages
- **Browser extension integration** — intercept downloads from your browser with cookie forwarding
- **Pause / Resume / Retry** — with exponential backoff retry on failure
- **Queue management** — configurable max concurrent downloads
- **Category-based auto-sorting** — auto-organize downloads by file type
- **System tray** — runs in background with tray controls
- **TS to MP4 conversion** — built-in ffmpeg stream copy for HLS downloads

## Tech Stack

- **Backend:** Rust + Tauri 2
- **Frontend:** Vanilla HTML/CSS/JS
- **Database:** SQLite (via rusqlite)
- **HTTP:** reqwest + tokio async runtime

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) (LTS)
- [ffmpeg](https://ffmpeg.org/) (optional, for TS to MP4 conversion)

### Build & Run

```bash
npm install
npx tauri dev
```

### Build for production

```bash
npx tauri build
```

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

Copyright (C) 2026 HuyAiT
