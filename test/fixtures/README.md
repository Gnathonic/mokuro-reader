# Test Fixtures

This folder is for local test files (CBZ/ZIP files with mokuro data) that should NOT be committed to git.

## Usage

Place your mokuro-processed CBZ files here for testing:

```
test/fixtures/
├── README.md          (this file - committed)
├── .gitkeep           (committed)
├── sample-volume.cbz  (ignored)
├── manga-title/       (ignored)
│   ├── vol01.cbz
│   └── vol02.cbz
└── ...
```

## Expected CBZ Structure

Each CBZ file should contain:

- A `.mokuro` JSON file with OCR data
- Image files (JPG/PNG) for each page

```
volume.cbz
├── volume.mokuro      (JSON with page data)
├── 001.jpg
├── 002.jpg
└── ...
```

## Running Tests with Fixtures

```bash
# Run integration tests that use fixtures
npm test -- test/integration

# Or run specific fixture-based tests
npm test -- --grep "fixture"
```

## Creating Test Fixtures

1. Process a manga volume with [mokuro](https://github.com/kha-white/mokuro)
2. Zip the output folder as a `.cbz` file
3. Place it in this directory
