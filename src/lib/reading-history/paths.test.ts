import { describe, expect, it } from 'vitest';
import {
  historyDeviceFilePath,
  historyMonthOf,
  historySegmentPath,
  isHistoryFileName,
  isHistoryFilePath,
  parseHistoryPath
} from './paths';

const DEV = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';

describe('history paths', () => {
  it('months are UTC, including the last millisecond of a month', () => {
    expect(historyMonthOf(Date.UTC(2026, 9, 31, 23, 59, 59, 999))).toBe('2026-10');
    expect(historyMonthOf(Date.UTC(2026, 10, 1, 0, 0, 0, 0))).toBe('2026-11');
    expect(historyMonthOf(Date.UTC(2027, 0, 5))).toBe('2027-01');
  });

  it('builds and parses segment and device paths', () => {
    expect(historySegmentPath(DEV, '2026-10')).toBe(`history/${DEV}/2026-10.events`);
    expect(historyDeviceFilePath(DEV)).toBe(`history/${DEV}/device.json`);
    expect(parseHistoryPath(`history/${DEV}/2026-10.events`)).toEqual({
      device: DEV,
      kind: 'month',
      month: '2026-10'
    });
    expect(parseHistoryPath(`history/${DEV}/device.json`)).toEqual({ device: DEV, kind: 'device' });
  });

  it.each([
    'history/2026-10.events',
    `history/${DEV}/sub/2026-10.events`,
    `History/${DEV}/2026-10.events`,
    `history/${DEV}/2026-13.events`,
    `history/${DEV}/2026-1.events`,
    `history/${DEV}/notes.json`,
    `history/bad id!/2026-10.events`,
    `Series/${DEV}/2026-10.events`,
    `history/${DEV}/2026-10.events.bak`
  ])('rejects %s', (path) => {
    expect(parseHistoryPath(path)).toBeNull();
    expect(isHistoryFilePath(path)).toBe(false);
  });

  it('recognises history basenames for listing prefilters', () => {
    expect(isHistoryFileName('2026-10.events')).toBe(true);
    expect(isHistoryFileName('device.json')).toBe(true);
    expect(isHistoryFileName('volume-data.json')).toBe(false);
  });
});
