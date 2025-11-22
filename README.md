# Mokuro reader

An online reader, gallery and stat tracker for [mokuro](https://github.com/kha-white/mokuro) processed manga.

https://github.com/ZXY101/mokuro-reader/assets/39561296/45a214a8-3f69-461c-87d7-25b17dea3060

## ✨ Features:

- Stat tracking (volumes read, pages read, characters read & minutes read)
- Extensive customization and profile support
- Anki connect integration with image cropping and configurable quality/size settings
- Cloud sync support (Google Drive and MEGA) for syncing read progress and volumes across devices
- Automatic dual-page mode
- Installation and offline support

## 🚀 Usage:

You can find the reader hosted [here](https://reader.mokuro.app/).

To import your manga, process it with mokuro and then upload your manga along with the generated `.mokuro` file.

Requires mokuro version 'v0.2.0' or later to generate the `.mokuro` file.

```bash
pip install git+https://github.com/kha-white/mokuro.git@web-reader
```

Once installed and your manga is processed, import your manga into the reader. Alternatively, use cloud sync to access your volumes across devices.

## 🛠 Development:

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
