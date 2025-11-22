import { describe, it, expect } from 'vitest';
import { escapeNameForDriveQuery } from './api-client';

describe('escapeNameForDriveQuery', () => {
  it('should return string unchanged when no special characters', () => {
    expect(escapeNameForDriveQuery('simple-name')).toBe('simple-name');
    expect(escapeNameForDriveQuery('My Volume 01')).toBe('My Volume 01');
    expect(escapeNameForDriveQuery('Manga_Title')).toBe('Manga_Title');
  });

  it('should escape single quotes', () => {
    expect(escapeNameForDriveQuery("It's a test")).toBe("It\\'s a test");
    expect(escapeNameForDriveQuery("Don't Stop")).toBe("Don\\'t Stop");
    expect(escapeNameForDriveQuery("'quoted'")).toBe("\\'quoted\\'");
  });

  it('should escape backslashes', () => {
    expect(escapeNameForDriveQuery('path\\to\\file')).toBe('path\\\\to\\\\file');
    expect(escapeNameForDriveQuery('test\\')).toBe('test\\\\');
    expect(escapeNameForDriveQuery('\\start')).toBe('\\\\start');
  });

  it('should escape both quotes and backslashes', () => {
    expect(escapeNameForDriveQuery("It\\'s escaped")).toBe("It\\\\\\'s escaped");
    expect(escapeNameForDriveQuery("path\\file's")).toBe("path\\\\file\\'s");
  });

  it('should handle multiple occurrences', () => {
    expect(escapeNameForDriveQuery("it's it's it's")).toBe("it\\'s it\\'s it\\'s");
    expect(escapeNameForDriveQuery('a\\b\\c\\d')).toBe('a\\\\b\\\\c\\\\d');
  });

  it('should handle empty string', () => {
    expect(escapeNameForDriveQuery('')).toBe('');
  });

  it('should handle Japanese characters with special chars', () => {
    expect(escapeNameForDriveQuery("お嬢様's日記")).toBe("お嬢様\\'s日記");
    expect(escapeNameForDriveQuery('日本\\語')).toBe('日本\\\\語');
  });

  it('should handle real-world folder names with apostrophes', () => {
    // This is the critical use case mentioned in CLAUDE.md
    expect(escapeNameForDriveQuery('Ascendance of a Bookworm')).toBe('Ascendance of a Bookworm');
    expect(escapeNameForDriveQuery("Mother's Rosario")).toBe("Mother\\'s Rosario");
    expect(escapeNameForDriveQuery("The King's Avatar")).toBe("The King\\'s Avatar");
  });
});
