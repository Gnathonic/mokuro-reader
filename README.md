# Mokuro Reader

[![Discord](https://img.shields.io/discord/1437608126122557450?color=7289da&logo=discord&logoColor=white&label=Discord)](https://discord.gg/AU5pjjSQBw)

A powerful web-based manga reader with advanced analytics, cloud sync, and intelligent features for [mokuro](https://github.com/kha-white/mokuro) processed manga.

https://github.com/ZXY101/mokuro-reader/assets/39561296/45a214a8-3f69-461c-87d7-25b17dea3060

## ✨ Features

### 📚 Reading Experience

- **Smart Page Mode Detection** - Automatically switches between single and dual-page modes based on screen orientation and image content analysis
- **Page Preloading** - Non-blocking preload system for smooth page transitions
- **Smooth Page Transitions** - Configurable animations (instant/fade/slide) for page changes
- **Night Mode & Color Inversion** - Built-in visual comfort options
- **Automatic Text Sizing** - Intelligent text wrapping and resizing for oversized OCR text
- **Auto-Pause Timer** - Configurable timer that pauses after inactivity (1-30 minutes, default 5)
- **Seamless Navigation** - Paging past volume end automatically loads next volume or returns to series page

### 📊 Analytics & Tracking

- **Reading Speed Tracking** - Real-time speed calculation with historical data
- **Progress History & Graphs** - Visual charts showing reading progress over time
- **Achievements System** - Motivational milestones and reading goals
- **Time-to-Finish Estimates** - Smart predictions based on your reading speed for both volumes and series
- **Comprehensive Stats** - Track volumes read, pages read, characters read, and time spent reading
- **Per-Volume Analytics** - Character counts and progress tracking for each volume
- **Series-Level Stats** - Aggregate statistics across entire manga series

### ☁️ Cloud Integration

- **Google Drive Sync** - Full integration with automatic token refresh and reconnection
- **MEGA Support** - Alternative cloud storage option
- **Automatic Progress Sync** - Seamlessly sync read progress and stats across devices
- **Easy Backup** - Backup your entire library to Google Drive, MEGA, or WebDAV (coming soon)
- **Smart Placeholder System** - Backed up volumes appear as downloadable placeholders in your catalog
- **One-Tap Downloads** - Download cloud volumes directly from your catalog on your other devices
- **Cross-Device Continuity** - Pick up exactly where you left off on any device

### 🎨 Customization & Profiles

- **User Profiles** - Multiple reading profiles with independent settings
- **Per-Volume Settings** - Override global settings for specific volumes
- **Extensive Reader Options** - Customize text display, zoom behavior, page mode, and more
- **Profile-Based Defaults** - Different default settings for different reading styles

### 🔧 Power Features

- **Anki Connect Integration** - Export vocabulary with image cropping and configurable quality/size settings
- **Text Analysis Tools** - Dedicated text pages for both volumes and series for analysis by browser extensions
- **Advanced Sorting** - Multiple sorting modes for catalog and series pages
- **Robust Import System** - Handles complex arrangements of ZIPs, CBZs, files, folders, and mokuro files
- **Drag-and-Drop Import** - Import files by dropping them anywhere in the app
- **Flexible File Handling** - Much more robust handling of special characters in file and folder names
- **Batch Operations** - Efficient handling of large volume collections

### ⚡ Performance & Scale

- **Handles 2000+ Volumes** - Completely rewritten database architecture for performance at scale
- **Worker Pool Architecture** - Parallel processing for downloads and imports
- **Memory Management** - Smart memory limits and throttle modes for low-memory devices
- **Optimized Database** - Restructured to prevent out-of-memory errors on long series
- **Image Caching** - Intelligent caching system for faster page loads
- **Service Worker Support** - PWA capabilities with offline functionality
- **PWA File Association** - Double-click `.cbz` files to open directly in the reader

## ⌨️ Keyboard Shortcuts

| Key                     | Action                                                 |
| ----------------------- | ------------------------------------------------------ |
| `N`                     | Toggle night mode                                      |
| `I`                     | Toggle color inversion                                 |
| `P`                     | Toggle page mode (single/dual)                         |
| `C`                     | Toggle cover display                                   |
| `Z`                     | Toggle zoom mode                                       |
| `F`                     | Toggle fullscreen                                      |
| `Esc`                   | Exit current volume (or exit series if on series page) |
| `←` / `→`               | Navigate to previous/next page                         |
| `↑` / `↓`               | Pan view up/down                                       |
| `Space` / `PageDown`    | Next page                                              |
| `PageUp`                | Previous page                                          |
| `Home`                  | Jump to first page                                     |
| `End`                   | Jump to last page                                      |
| `Ctrl` + `Scroll Wheel` | Zoom in/out                                            |

## 🚀 Usage

### Quick Start

You can access the reader at [reader.mokuro.app](https://reader.mokuro.app/).

**To import manga:**

1. Process your manga with mokuro (see requirements below)
2. Upload the processed folder or ZIP containing your manga images and the `.mokuro` file
3. Start reading!

**Requirements:** Mokuro version `0.2.0` or later is required to generate the `.mokuro` file.

```bash
pip install mokuro
```

### Cloud Sync Setup

**Google Drive:**

1. Navigate to the Cloud page in settings
2. Click "Connect to Google Drive"
3. Authorize the application
4. Your volumes and progress will automatically sync

The reader remembers your connection and can auto-refresh tokens when they expire.

**MEGA:**

1. Navigate to the Cloud page in settings
2. Enter your MEGA credentials
3. Upload volumes directly from the reader or use MEGA's interface
4. Cloud volumes appear as downloadable placeholders in your catalog

### Reading Speed Features

The reader automatically tracks your reading speed and provides:

- **Real-time speed** displayed during reading
- **Historical graphs** showing speed trends over time
- **Time estimates** for finishing current volume and series
- **Achievements** for reaching reading milestones

### Text Analysis

Each volume and series has a dedicated text analysis page:

- View all text extracted from the manga
- Useful for vocabulary mining
- Export to Anki with custom cropping and formatting
- Analyze character frequency across series

## 🛠 Development

### Requirements

- Node.js (latest LTS version recommended)
- npm

Clone the repo:

```bash
git clone https://github.com/ZXY101/mokuro-reader
cd mokuro-reader
```

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Run tests:

```bash
npm test
```

### Environment Variables

For Google Drive integration, create a `.env` file:

```env
VITE_GDRIVE_CLIENT_ID=your_client_id
VITE_GDRIVE_API_KEY=your_api_key
```

## 📈 What's New in v1.0.0

This release represents a major overhaul of Mokuro Reader with significant improvements across all areas:

### Major Features Added

- 📊 Complete reading speed tracking system with history, graphs, and achievements
- 🤖 Automatic single/dual page mode detection based on content analysis
- ⌨️ Comprehensive keyboard shortcut system (N/I/P/C/Z/Esc)
- ☁️ Enhanced cloud integration with placeholder system and one-tap downloads
- 🎨 Page transition animations with multiple styles (instant/fade/slide)
- 📝 Volume and series text analysis pages
- ⏱️ Auto-pause timer with configurable timeout
- 🎯 Time-to-finish estimates based on reading speed

### Performance Improvements

- 🚀 Complete database restructure - now handles 2000+ volumes with ease
- ⚡ Worker pool architecture for parallel downloads and processing
- 💾 Advanced memory management with throttle modes for low-end devices
- 🖼️ Image caching system for faster page loads
- 📦 Restructured database to prevent out-of-memory errors

### UI/UX Enhancements

- 🖼️ Series now display with up to 3 stacked thumbnails
- ✅ Series completion markers in catalog
- 🔢 Character counts and time estimates on volume cards
- 📑 Advanced sorting options for catalog and series pages
- 🎨 Night mode and color inversion toggles
- 🔄 Improved navigation with seamless volume-to-volume transitions

### Cloud & Sync

- ☁️ Automatic progress synchronization across devices
- 🔄 Persistent Google Drive connection with auto token refresh
- 📥 Smart placeholder system for cloud-only volumes
- 🌐 Full MEGA integration alongside Google Drive

### Technical Improvements

- ⬆️ Updated to latest Svelte 5 and Node.js versions
- 🧠 Shared memory manager for better resource utilization
- 🔧 Much more robust file and folder name handling
- 📦 Flexible import system handling various ZIP/CBZ/folder arrangements
- 🔒 Better error handling and recovery mechanisms

### Bug Fixes

- Fixed upload issues on weaker devices
- Resolved memory issues with long series
- Improved stability across all operations

## 💬 Community

Wanna chat with the devs? Share your hopes, dreams, and issues (with Mokuro Reader specifically)? Come join the [Mokuro Reader Discord](https://discord.gg/AU5pjjSQBw)!

## 🙏 Credits

Created by [ZXY101](https://github.com/ZXY101), [kha-white](https://github.com/kha-white) & [Gnathonic](https://github.com/Gnathonic)

## 📄 License

This project is open source and available under the GNU General Public License v3.0.
