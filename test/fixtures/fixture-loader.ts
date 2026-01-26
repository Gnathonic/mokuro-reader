/**
 * Utility for loading test fixtures (both extracted directories and CBZ files).
 * Extracted fixtures are faster to load and preferred for most tests.
 * CBZ fixtures are used for ZIP-specific tests.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';

const FIXTURES_DIR = join(__dirname);
const EXTRACTED_DIR = join(__dirname, 'extracted');

export interface FixtureInfo {
  name: string;
  path: string;
  type: 'extracted' | 'cbz';
  size: number;
}

export interface ExtractedFixture {
  name: string;
  mokuroPath: string;
  imageDir: string;
  imageFiles: string[];
}

/**
 * Get list of available extracted fixtures (preferred for fast tests)
 */
export function getExtractedFixtures(): ExtractedFixture[] {
  if (!existsSync(EXTRACTED_DIR)) {
    return [];
  }

  const dirs = readdirSync(EXTRACTED_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

  return dirs
    .map((dir) => {
      const dirPath = join(EXTRACTED_DIR, dir.name);
      const files = readdirSync(dirPath, { recursive: true }) as string[];

      // Find .mokuro file
      const mokuroFile = files.find((f) => f.toString().endsWith('.mokuro'));
      if (!mokuroFile) return null;

      // Find image files
      const imageFiles = files.filter((f) =>
        /\.(jpg|jpeg|png|webp|gif)$/i.test(f.toString())
      ) as string[];

      return {
        name: dir.name,
        mokuroPath: join(dirPath, mokuroFile.toString()),
        imageDir: dirPath,
        imageFiles: imageFiles.map((f) => f.toString())
      };
    })
    .filter((f): f is ExtractedFixture => f !== null);
}

/**
 * Get list of available CBZ fixtures (for ZIP-specific tests)
 */
export function getCBZFixtures(): FixtureInfo[] {
  if (!existsSync(FIXTURES_DIR)) {
    return [];
  }

  const files = readdirSync(FIXTURES_DIR, { withFileTypes: true });

  return files
    .filter((f) => f.isFile() && (f.name.endsWith('.cbz') || f.name.endsWith('.zip')))
    .map((f) => {
      const filePath = join(FIXTURES_DIR, f.name);
      const stats = statSync(filePath);
      return {
        name: f.name,
        path: filePath,
        type: 'cbz' as const,
        size: stats.size
      };
    });
}

/**
 * Get all available fixtures (prefers extracted, falls back to CBZ)
 */
export function getAvailableFixtures(): FixtureInfo[] {
  const extracted = getExtractedFixtures().map((f) => ({
    name: f.name,
    path: f.mokuroPath,
    type: 'extracted' as const,
    size: 0
  }));

  if (extracted.length > 0) {
    return extracted;
  }

  return getCBZFixtures();
}

/**
 * Load mokuro data from an extracted fixture (very fast)
 */
export function loadExtractedMokuro(fixture: ExtractedFixture): any {
  const content = readFileSync(fixture.mokuroPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Load a CBZ fixture file as a Buffer (for ZIP tests)
 */
export function loadFixtureBuffer(filename: string): Buffer | null {
  const filePath = join(FIXTURES_DIR, filename);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath);
}

/**
 * Load a fixture file as a File object (for browser-like tests)
 */
export function loadFixtureAsFile(filename: string): File | null {
  const buffer = loadFixtureBuffer(filename);
  if (!buffer) {
    return null;
  }

  const type = filename.endsWith('.cbz') ? 'application/x-cbz' : 'application/zip';
  return new File([buffer], filename, { type });
}

/**
 * Check if any fixtures are available
 */
export function hasFixtures(): boolean {
  return getExtractedFixtures().length > 0 || getCBZFixtures().length > 0;
}

/**
 * Check if extracted fixtures are available (preferred)
 */
export function hasExtractedFixtures(): boolean {
  return getExtractedFixtures().length > 0;
}
