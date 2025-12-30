# Import Test Fixtures

This directory contains real file structures used for:
1. **Automated testing** of the import pairing logic
2. **Documentation** showing correct file organization for users

## Directory Structure

Each subdirectory represents a test case category:

```
fixtures/
├── basic/                    # Simple pairing scenarios
├── toc-format/               # Table-of-contents style (one mokuro, multiple chapter dirs)
├── internal-mokuro/          # Archives with mokuro inside
├── multiple-volumes/         # Multiple volumes in one drop
├── image-only/               # Directories without mokuro files
└── edge-cases/               # Unicode names, nested structures, etc.
```

## Test Case Format

Each test case has:
- `input/` - The files as they would be dropped/selected
- `expected.json` - The expected pairing output

## Placeholder Files

- **Images**: 10x10 pixel placeholder JPEGs (valid but tiny)
- **Mokuro files**: Minimal valid JSON with test data
- **Archives**: Real .cbz files containing the above

## Adding New Test Cases

1. Create a new directory under the appropriate category
2. Add an `input/` directory with the file structure
3. Add an `expected.json` describing expected pairings
4. Run `npm run fixtures:build` to generate any needed archives
