/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck - This file uses Node.js APIs and is only run by vitest
/**
 * Fixture loader for import tests
 *
 * Reads fixture directories and converts them to FileEntry arrays
 * for testing the pairing logic.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative } from 'path';
import type { FileEntry, ExpectedPairing, CategorizedFile } from '../../types';
import { categorizeFile } from '../../types';

const FIXTURES_ROOT = join(__dirname, '..', 'fixtures');

/**
 * A loaded test fixture with input files and expected output
 */
export interface LoadedFixture {
  /** Name of the fixture (directory name) */
  name: string;
  /** Category (parent directory name) */
  category: string;
  /** Full path to the fixture */
  path: string;
  /** Input files as FileEntry array */
  inputs: FileEntry[];
  /** Categorized inputs for easier assertions */
  categorizedInputs: CategorizedFile[];
  /** Expected pairing output */
  expected: ExpectedPairing;
}

/**
 * Load a single fixture by category and name
 */
export async function loadFixture(category: string, name: string): Promise<LoadedFixture> {
  const fixturePath = join(FIXTURES_ROOT, category, name);
  const inputPath = join(fixturePath, 'input');
  const expectedPath = join(fixturePath, 'expected.json');

  // Check fixture exists
  try {
    await stat(fixturePath);
  } catch {
    throw new Error(`Fixture not found: ${category}/${name}`);
  }

  // Load input files
  const inputs = await loadDirectoryAsFileEntries(inputPath);
  const categorizedInputs = inputs.map(categorizeFile);

  // Load expected output
  let expected: ExpectedPairing;
  try {
    const expectedJson = await readFile(expectedPath, 'utf-8');
    expected = JSON.parse(expectedJson);
  } catch {
    throw new Error(`Missing or invalid expected.json for fixture: ${category}/${name}`);
  }

  return {
    name,
    category,
    path: fixturePath,
    inputs,
    categorizedInputs,
    expected
  };
}

/**
 * Load all fixtures in a category
 */
export async function loadFixtureCategory(category: string): Promise<LoadedFixture[]> {
  const categoryPath = join(FIXTURES_ROOT, category);

  try {
    const entries = await readdir(categoryPath, { withFileTypes: true });
    const fixtures: LoadedFixture[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        try {
          const fixture = await loadFixture(category, entry.name);
          fixtures.push(fixture);
        } catch (e) {
          // Skip invalid fixtures but log warning
          console.warn(`Skipping invalid fixture ${category}/${entry.name}:`, e);
        }
      }
    }

    return fixtures;
  } catch {
    throw new Error(`Fixture category not found: ${category}`);
  }
}

/**
 * Load all fixtures across all categories
 */
export async function loadAllFixtures(): Promise<LoadedFixture[]> {
  const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
  const allFixtures: LoadedFixture[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const categoryFixtures = await loadFixtureCategory(entry.name);
      allFixtures.push(...categoryFixtures);
    }
  }

  return allFixtures;
}

/**
 * Recursively load a directory as FileEntry array
 * Creates mock File objects from the actual files
 */
async function loadDirectoryAsFileEntries(
  dirPath: string,
  basePath: string = ''
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  let dirEntries;
  try {
    dirEntries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    // Directory doesn't exist, return empty
    return entries;
  }

  for (const entry of dirEntries) {
    const fullPath = join(dirPath, entry.name);
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      // Recurse into subdirectory
      const subEntries = await loadDirectoryAsFileEntries(fullPath, relativePath);
      entries.push(...subEntries);
    } else if (entry.isFile() && !entry.name.startsWith('.')) {
      // Create a File object from the actual file
      const buffer = await readFile(fullPath);
      const file = createMockFile(buffer, entry.name, getMimeType(entry.name));

      entries.push({
        path: relativePath,
        file
      });
    }
  }

  return entries;
}

/**
 * Create a mock File object from a buffer
 */
function createMockFile(buffer: Buffer, name: string, type: string): File {
  // In Node.js test environment, we need to create a File-like object
  // The actual File API might not be available, so we create a compatible object
  const blob = new Blob([buffer], { type });

  // Create a File-like object
  const file = new File([blob], name, { type });

  return file;
}

/**
 * Get MIME type from filename
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    zip: 'application/zip',
    cbz: 'application/zip',
    cbr: 'application/x-rar-compressed',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    mokuro: 'application/json',
    json: 'application/json'
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * List available fixture categories
 */
export async function listFixtureCategories(): Promise<string[]> {
  const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
}

/**
 * List fixtures in a category
 */
export async function listFixturesInCategory(category: string): Promise<string[]> {
  const categoryPath = join(FIXTURES_ROOT, category);
  const entries = await readdir(categoryPath, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
}
