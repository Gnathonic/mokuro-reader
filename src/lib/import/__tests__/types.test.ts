import { describe, it, expect } from 'vitest';
import {
  isSystemFile,
  isImageExtension,
  isArchiveExtension,
  isMokuroExtension,
  parseFilePath
} from '../types';

describe('isSystemFile', () => {
  describe('macOS system files', () => {
    it('should exclude __MACOSX directories', () => {
      expect(isSystemFile('__MACOSX/image.jpg')).toBe(true);
      expect(isSystemFile('manga/__MACOSX/._image.jpg')).toBe(true);
    });

    it('should exclude .DS_Store files', () => {
      expect(isSystemFile('.DS_Store')).toBe(true);
      expect(isSystemFile('manga/.DS_Store')).toBe(true);
    });

    it('should exclude resource fork files (._prefix)', () => {
      expect(isSystemFile('._image.jpg')).toBe(true);
      expect(isSystemFile('manga/._page001.jpg')).toBe(true);
    });

    it('should exclude other macOS system directories', () => {
      expect(isSystemFile('.Trashes/file')).toBe(true);
      expect(isSystemFile('.Spotlight-V100/index')).toBe(true);
      expect(isSystemFile('.fseventsd/data')).toBe(true);
      expect(isSystemFile('.TemporaryItems/file')).toBe(true);
      expect(isSystemFile('.Trash/file')).toBe(true);
    });
  });

  describe('Windows system files', () => {
    it('should exclude Thumbs.db', () => {
      expect(isSystemFile('Thumbs.db')).toBe(true);
      expect(isSystemFile('manga/Thumbs.db')).toBe(true);
    });

    it('should exclude desktop.ini', () => {
      expect(isSystemFile('desktop.ini')).toBe(true);
      expect(isSystemFile('Desktop.ini')).toBe(true);
    });

    it('should exclude recycle bin directories', () => {
      expect(isSystemFile('$RECYCLE.BIN/file')).toBe(true);
      expect(isSystemFile('RECYCLER/file')).toBe(true);
      expect(isSystemFile('RECYCLED/file')).toBe(true);
    });

    it('should exclude System Volume Information', () => {
      expect(isSystemFile('System Volume Information/index')).toBe(true);
    });
  });

  describe('Linux system files', () => {
    it('should exclude .Trash-1000', () => {
      expect(isSystemFile('.Trash-1000/file')).toBe(true);
    });

    it('should exclude .thumbnails', () => {
      expect(isSystemFile('.thumbnails/thumb.png')).toBe(true);
    });

    it('should exclude .directory', () => {
      expect(isSystemFile('.directory')).toBe(true);
    });
  });

  describe('cloud storage files', () => {
    it('should exclude .dropbox directories', () => {
      expect(isSystemFile('.dropbox')).toBe(true);
      expect(isSystemFile('.dropbox.cache/file')).toBe(true);
    });
  });

  describe('version control', () => {
    it('should exclude .git directories', () => {
      expect(isSystemFile('.git/config')).toBe(true);
      expect(isSystemFile('manga/.git/objects')).toBe(true);
    });

    it('should exclude .svn directories', () => {
      expect(isSystemFile('.svn/entries')).toBe(true);
    });
  });

  describe('temporary and backup files', () => {
    it('should exclude files ending with ~', () => {
      expect(isSystemFile('file.txt~')).toBe(true);
      expect(isSystemFile('manga/page001.jpg~')).toBe(true);
    });

    it('should exclude .bak files', () => {
      expect(isSystemFile('file.bak')).toBe(true);
      expect(isSystemFile('manga/data.bak')).toBe(true);
    });

    it('should exclude .tmp files', () => {
      expect(isSystemFile('file.tmp')).toBe(true);
    });

    it('should exclude .temp files', () => {
      expect(isSystemFile('file.temp')).toBe(true);
    });
  });

  describe('valid manga files', () => {
    it('should not exclude normal image files', () => {
      expect(isSystemFile('page001.jpg')).toBe(false);
      expect(isSystemFile('manga/volume1/page001.png')).toBe(false);
    });

    it('should not exclude mokuro files', () => {
      expect(isSystemFile('volume.mokuro')).toBe(false);
      expect(isSystemFile('manga/series/volume.mokuro')).toBe(false);
    });

    it('should not exclude archive files', () => {
      expect(isSystemFile('volume.cbz')).toBe(false);
      expect(isSystemFile('manga.zip')).toBe(false);
    });
  });

  describe('path normalization', () => {
    it('should handle backslash paths', () => {
      expect(isSystemFile('manga\\__MACOSX\\file.jpg')).toBe(true);
      expect(isSystemFile('manga\\.DS_Store')).toBe(true);
    });

    it('should handle mixed separators', () => {
      expect(isSystemFile('manga/__MACOSX\\file.jpg')).toBe(true);
    });
  });
});

describe('parseFilePath', () => {
  it('should extract parent directory', () => {
    expect(parseFilePath('manga/volume/page.jpg').parentDir).toBe('manga/volume');
    expect(parseFilePath('page.jpg').parentDir).toBe('');
  });

  it('should extract filename', () => {
    expect(parseFilePath('manga/page.jpg').filename).toBe('page.jpg');
  });

  it('should extract stem', () => {
    expect(parseFilePath('manga/page.jpg').stem).toBe('page');
  });

  it('should extract extension', () => {
    expect(parseFilePath('manga/page.jpg').extension).toBe('jpg');
    expect(parseFilePath('manga/page.JPG').extension).toBe('jpg');
  });
});

describe('extension checks', () => {
  it('isImageExtension should recognize image formats', () => {
    expect(isImageExtension('jpg')).toBe(true);
    expect(isImageExtension('jpeg')).toBe(true);
    expect(isImageExtension('png')).toBe(true);
    expect(isImageExtension('webp')).toBe(true);
    expect(isImageExtension('gif')).toBe(true);
    expect(isImageExtension('avif')).toBe(true);
    expect(isImageExtension('txt')).toBe(false);
  });

  it('isArchiveExtension should recognize archive formats', () => {
    expect(isArchiveExtension('zip')).toBe(true);
    expect(isArchiveExtension('cbz')).toBe(true);
    expect(isArchiveExtension('cbr')).toBe(true);
    expect(isArchiveExtension('rar')).toBe(true);
    expect(isArchiveExtension('7z')).toBe(true);
    expect(isArchiveExtension('jpg')).toBe(false);
  });

  it('isMokuroExtension should recognize mokuro files', () => {
    expect(isMokuroExtension('mokuro')).toBe(true);
    expect(isMokuroExtension('MOKURO')).toBe(true);
    expect(isMokuroExtension('json')).toBe(false);
  });
});
