import { describe, it, expect } from 'vitest';
import { isSyncableFile, isCbzFile, isSidecarFile, isRootConfigFile } from './syncable-file';

describe('syncable-file', () => {
  it('accepts cbz, mokuro, mokuro.gz anywhere in the tree', () => {
    expect(isSyncableFile('Series/Vol 1.cbz')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.mokuro')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.mokuro.gz')).toBe(true);
  });

  it('accepts webp AND jpg/jpeg sidecar thumbnails (parity with mature providers)', () => {
    expect(isSyncableFile('Series/Vol 1.webp')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.jpg')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.JPEG')).toBe(true);
  });

  it('accepts the root config files', () => {
    expect(isSyncableFile('volume-data.json')).toBe(true);
    expect(isSyncableFile('profiles.json')).toBe(true);
  });

  it('ignores libraries.json left behind by the removed libraries feature', () => {
    expect(isSyncableFile('libraries.json')).toBe(false);
    expect(isRootConfigFile('libraries.json')).toBe(false);
  });

  it('rejects everything else', () => {
    expect(isSyncableFile('Series/notes.txt')).toBe(false);
    expect(isSyncableFile('Series/random.json')).toBe(false);
    expect(isSyncableFile('desktop.ini')).toBe(false);
  });

  it('is case-insensitive and uses the basename only', () => {
    expect(isSyncableFile('Series/VOL.CBZ')).toBe(true);
    expect(isSyncableFile('a/b/c/PROFILES.JSON')).toBe(true);
  });

  it('exposes category predicates for providers that bucket by type', () => {
    expect(isCbzFile('v.cbz')).toBe(true);
    expect(isSidecarFile('v.mokuro')).toBe(true);
    expect(isSidecarFile('v.jpeg')).toBe(true);
    expect(isSidecarFile('v.cbz')).toBe(false);
    expect(isRootConfigFile('profiles.json')).toBe(true);
    expect(isRootConfigFile('v.cbz')).toBe(false);
  });
});
