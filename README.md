# Mokuro Reader

[![Discord](https://img.shields.io/discord/1437608126122557450?color=7289da&logo=discord&logoColor=white&label=Discord)](https://discord.gg/AU5pjjSQBw)

A powerful web-based manga reader with advanced analytics, cloud sync, and intelligent features for [mokuro](https://github.com/kha-white/mokuro) processed manga.

https://github.com/ZXY101/mokuro-reader/assets/39561296/45a214a8-3f69-461c-87d7-25b17dea3060

## ✨ Features

### 📚 Reading Experience

- **Smart Page Mode Detection** - Automatically switches between single and dual-page modes based on screen orientation and image content analysis
- **Page Preloading** - Non-blocking preload system for smooth page transitions
- **Smooth Page Transitions** - Configurable animations (instant/fade/slide) for page changes
- **Night Mode & Color Inversion** - Built-in visual comfort options with optional scheduling
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
- **Easy Backup** - Backup your entire library to Google Drive, MEGA, or WebDAV
- **Smart Placeholder System** - Backed up volumes appear as downloadable placeholders in your catalog
- **One-Tap Downloads** - Download cloud volumes directly from your catalog on your other devices
- **Cross-Device Continuity** - Pick up exactly where you left off on any device

### 🎨 Customization & Profiles

- **User Profiles** - Multiple reading profiles with independent settings
- **Per-Volume Settings** - Override global settings for specific volumes
- **Catalog Display Presets** - Choose from Compact, Default, or Spine Showcase layouts
- **Extensive Reader Options** - Customize text display, zoom behavior, page mode, and more

### 🔧 Power Features

- **Context Menu for Text Boxes** - Right-click or long-press OCR text boxes for quick copy and Anki card creation
- **Copy Without Linebreaks** - Copied text automatically strips linebreaks for cleaner pasting
- **Text Analysis Tools** - Dedicated text pages for both volumes and series for analysis by browser extensions
- **Advanced Sorting** - Multiple sorting modes for catalog and series pages
- **Robust Import System** - Handles complex arrangements of ZIPs, CBZs, files, folders, and mokuro files
- **Partial Volume Support** - Import volumes even when some images are missing, with placeholder pages
- **Drag-and-Drop Import** - Import files by dropping them anywhere in the app
- **Import Progress Tracking** - Visual progress indicator for file imports
- **Flexible File Handling** - Much more robust handling of special characters in file and folder names
- **Batch Operations** - Efficient handling of large volume collections

### 🔗 Anki Connect Integration

- **Quick Capture** - Double-tap or right-click text boxes to create Anki cards
- **Textbox Targeting** - Choose which specific text box to capture when creating cards
- **Custom AnkiConnect URL** - Connect to AnkiConnect on another device or custom port
- **Card Modes** - Choose between updating the last card or creating new cards
- **Dynamic Tags** - Use template tags like `{series}` and `{volume}` for automatic card organization
- **Connection Testing** - Built-in test button to validate your AnkiConnect setup
- **Image Cropping** - Configurable image cropping with quality and size settings

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

Connect to **Google Drive**, **MEGA**, or **WebDAV** from the Cloud page in settings. All three providers support:

- Automatic progress and profile sync across devices
- Volume backup with one-tap restore on other devices
- Cloud-only volumes appear as downloadable placeholders in your catalog
- High-speed series backup and downloads using web workers

### Reading Speed Features

The reader automatically tracks your reading speed and provides:

- **Real-time speed** displayed during reading
- **Historical graphs** showing speed trends over time
- **Time estimates** for finishing current volume and series
- **Achievements** for reaching reading milestones

### Text Analysis

Each volume and series has a dedicated text analysis page:

- View all text extracted from the manga
- Useful for vocabulary mining with browser extensions like Yomitan
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

## 💬 Community

Wanna chat with the devs? Share your hopes, dreams, and issues (with Mokuro Reader specifically)? Come join the [Mokuro Reader Discord](https://discord.gg/AU5pjjSQBw)!

## 🙏 Credits

Created by [ZXY101](https://github.com/ZXY101), [kha-white](https://github.com/kha-white) & [Gnathonic](https://github.com/Gnathonic)

## 📄 License

This project is open source and available under the GNU General Public License v3.0.
