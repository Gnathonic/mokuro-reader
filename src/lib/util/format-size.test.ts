import { describe, expect, it } from 'vitest';
import { formatArchiveSize } from './format-size';

describe('formatArchiveSize', () => {
  it('drops the decimal once the number is big enough not to need it', () => {
    expect(formatArchiveSize(193_000_000)).toBe('184 MB');
    expect(formatArchiveSize(52_428_800)).toBe('50 MB');
  });

  it('keeps one decimal below ten, where it carries real information', () => {
    expect(formatArchiveSize(1_610_612_736)).toBe('1.5 GB');
    expect(formatArchiveSize(5_452_595)).toBe('5.2 MB');
  });

  it('never prints a rounded-up "10.0"', () => {
    expect(formatArchiveSize(Math.round(9.97 * 1024 * 1024))).toBe('10 MB');
  });

  it('starts at KB — bytes are not a useful unit for an archive', () => {
    expect(formatArchiveSize(4096)).toBe('4.0 KB');
    expect(formatArchiveSize(1024 * 1024)).toBe('1.0 MB');
  });

  it('climbs a unit when the rounding fills the one below', () => {
    // 1023.99… MB must not print as "1024 MB".
    expect(formatArchiveSize(1024 ** 3 - 1)).toBe('1.0 GB');
    expect(formatArchiveSize(1023 * 1024 ** 2)).toBe('1023 MB');
  });

  it('climbs to TB and stops there', () => {
    expect(formatArchiveSize(3 * 1024 ** 4)).toBe('3.0 TB');
    expect(formatArchiveSize(4096 * 1024 ** 4)).toBe('4096 TB');
  });

  it('says nothing rather than something wrong for a junk size', () => {
    expect(formatArchiveSize(0)).toBe('');
    expect(formatArchiveSize(-1)).toBe('');
    expect(formatArchiveSize(NaN)).toBe('');
  });
});
