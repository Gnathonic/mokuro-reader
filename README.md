# Mokuro reader 

An online reader, gallery and stat tracker for [mokuro](https://github.com/kha-white/mokuro) processed manga.

https://github.com/ZXY101/mokuro-reader/assets/39561296/45a214a8-3f69-461c-87d7-25b17dea3060

## Features:
- Stat tracking (volumes read, pages read, characters read & minutes read)
- Extensive customization and profile support
- Anki connect integration & image cropping
- Installation and offline support

## Usage:
You can find the reader hosted [here](https://reader.mokuro.app/).

To import your manga, process it with mokuro and then upload your manga along with the generated `.mokuro` file.

Requires mokuro version 'v0.2.0' or later to generate the `.mokuro` file.

```bash
pip install git+https://github.com/kha-white/mokuro.git@web-reader
```

Once installed and your manga is processed, import your manga into the reader.

## Google Drive Integration

The reader supports Google Drive integration for syncing your library and reading progress across devices. This feature uses OAuth 2.0 with refresh tokens to minimize the need for frequent logins.

### Setting up Google Drive API (for developers)

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Google Drive API
3. Create OAuth 2.0 credentials (Web application type)
4. Add authorized redirect URIs:
   - For development: `http://localhost:5173/api/auth/callback`
   - For production: `https://your-domain.com/api/auth/callback`
5. Copy the client ID, client secret, and API key
6. Create a `.env` file based on `.env.example` and add your credentials

## Development:

### Requirements
- Node.js (latest LTS version recommended)
- npm

Clone the repo:
```bash
git clone https://github.com/Gnathonic/mokuro-reader
cd mokuro-reader
```

Install dependencies:
```bash
npm install
```

Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your Google Drive API credentials
```

Start the dev server:
```bash
npm run dev
```