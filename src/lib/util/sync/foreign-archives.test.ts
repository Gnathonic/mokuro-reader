import { beforeEach, describe, expect, it } from 'vitest';
import {
  foreignArchiveNamesIn,
  isForeignArchiveFile,
  noteSkippedListedFile,
  resetForeignArchivesForTest
} from './foreign-archives';

describe('foreign archives the listings pass over', () => {
  beforeEach(() => resetForeignArchivesForTest());

  it('are .cbr, .zip and .rar by the fold of the name (R2), never a .cbz', () => {
    expect(isForeignArchiveFile('V.cbr')).toBe(true);
    expect(isForeignArchiveFile('V.ZIP')).toBe(true);
    expect(isForeignArchiveFile('V.ra​r')).toBe(true);
    expect(isForeignArchiveFile('V.cbz')).toBe(false);
    expect(isForeignArchiveFile('V.zip.mokuro')).toBe(false);
  });

  it('are kept per provider and per folder, any spelling of the folder finding them', () => {
    noteSkippedListedFile('webdav', 'Série/V.5.zip');
    noteSkippedListedFile('webdav', 'Série/notes.txt');
    noteSkippedListedFile('webdav', 'Other/W.rar');
    // A root file is no volume's.
    noteSkippedListedFile('webdav', 'loose.zip');
    expect(foreignArchiveNamesIn('webdav', 'SÉRIE')).toEqual(['V.5.zip']);
    expect(foreignArchiveNamesIn('webdav', '/Other/')).toEqual(['W.rar']);
    expect(foreignArchiveNamesIn('onedrive', 'Série')).toEqual([]);
    expect(foreignArchiveNamesIn('webdav', '')).toEqual([]);
  });
});
