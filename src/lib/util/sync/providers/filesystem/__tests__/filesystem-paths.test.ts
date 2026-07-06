import { describe, it, expect } from 'vitest';
import { splitPathSegments, isSyncableFile, getParentPath, getBasename } from '../filesystem-paths';

describe('splitPathSegments', () => {
  it('splits a typical volume path', () => {
    expect(splitPathSegments('Series/Volume.cbz')).toEqual(['Series', 'Volume.cbz']);
  });

  it('handles single-segment paths', () => {
    expect(splitPathSegments('volume-data.json')).toEqual(['volume-data.json']);
  });

  it('trims leading and trailing slashes', () => {
    expect(splitPathSegments('/Series/Volume.cbz/')).toEqual(['Series', 'Volume.cbz']);
  });

  it('drops empty segments from duplicate slashes', () => {
    expect(splitPathSegments('Series//Volume.cbz')).toEqual(['Series', 'Volume.cbz']);
  });

  it('returns empty array for empty string', () => {
    expect(splitPathSegments('')).toEqual([]);
  });
});

describe('isSyncableFile', () => {
  it.each([
    ['Series/Volume.cbz', true],
    ['Series/Volume.mokuro', true],
    ['Series/Volume.mokuro.gz', true],
    ['Series/Volume.webp', true],
    ['volume-data.json', true],
    ['profiles.json', true],
    ['libraries.json', false], // removed libraries feature — see syncable-file.ts
    ['Series/cover.jpg', true],
    ['.DS_Store', false],
    ['Series/Notes.txt', false],
    ['random.json', false]
  ])('%s -> %s', (name, expected) => {
    expect(isSyncableFile(name)).toBe(expected);
  });

  it('is case-insensitive on extensions', () => {
    expect(isSyncableFile('Series/Volume.CBZ')).toBe(true);
    expect(isSyncableFile('Series/Volume.Mokuro.GZ')).toBe(true);
  });
});

describe('getParentPath / getBasename', () => {
  it('splits a nested path', () => {
    expect(getParentPath('Series/Volume.cbz')).toBe('Series');
    expect(getBasename('Series/Volume.cbz')).toBe('Volume.cbz');
  });

  it('handles root-level files', () => {
    expect(getParentPath('volume-data.json')).toBe('');
    expect(getBasename('volume-data.json')).toBe('volume-data.json');
  });
});
