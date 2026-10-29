import { describe, expect, it } from 'vitest';
import {
  historyDeviceFilePath,
  historyLegacyFilePath,
  legacyDeviceFor,
  historyMonthOf,
  historySegmentPath,
  isHistoryFileName,
  isDeviceId,
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

  it('parses a legacy segment path', () => {
    expect(parseHistoryPath(`history/${DEV}/legacy.events`)).toEqual({
      device: DEV,
      kind: 'legacy'
    });
    expect(historyLegacyFilePath(DEV)).toBe(`history/${DEV}/legacy.events`);
    expect(isHistoryFileName('legacy.events')).toBe(true);
    expect(legacyDeviceFor('vol-1')).toBe('legacy:vol-1');
  });

  it('a device id is what may name a history folder; legacy pseudo-devices are not devices', () => {
    expect(isDeviceId(DEV)).toBe(true);
    expect(isDeviceId('A-1')).toBe(true);
    expect(isDeviceId('x'.repeat(64))).toBe(true);
    expect(isDeviceId('x'.repeat(65))).toBe(false);
    expect(isDeviceId('')).toBe(false);
    expect(isDeviceId(legacyDeviceFor('vol-1'))).toBe(false);
    expect(isDeviceId('bad id!')).toBe(false);
    // `devices/<id>` namespaces a device's bogus-stamp key in `tracking`:
    // no device id can contain the slash.
    expect(isDeviceId('devices/x')).toBe(false);
  });
});
