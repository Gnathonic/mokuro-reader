import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { HistoryDexie } from './history-db';
import { detectDeviceFacts, touchDeviceRecord, type DeviceEnv } from './device-facts';

const base: DeviceEnv = {
  userAgent: '',
  coarsePointer: false,
  maxTouchPoints: 0,
  screenShortSide: 1080
};

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadDesktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
  winEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
};

describe('detectDeviceFacts', () => {
  it.each([
    [
      'Android phone',
      { userAgent: UA.androidChrome, coarsePointer: true, maxTouchPoints: 5, screenShortSide: 412 },
      { class: 'phone', os: 'Android', browser: 'Chrome' }
    ],
    [
      'iPhone',
      { userAgent: UA.iphoneSafari, coarsePointer: true, maxTouchPoints: 5, screenShortSide: 390 },
      { class: 'phone', os: 'iOS', browser: 'Safari' }
    ],
    [
      'iPad reporting a desktop UA',
      {
        userAgent: UA.ipadDesktopSafari,
        coarsePointer: true,
        maxTouchPoints: 5,
        screenShortSide: 820
      },
      { class: 'tablet', os: 'iOS', browser: 'Safari' }
    ],
    [
      'iPad desktop UA with a trackpad (fine pointer)',
      {
        userAgent: UA.ipadDesktopSafari,
        coarsePointer: false,
        maxTouchPoints: 5,
        screenShortSide: 820
      },
      { class: 'tablet', os: 'iOS', browser: 'Safari' }
    ],
    [
      'Windows Firefox',
      { userAgent: UA.winFirefox },
      { class: 'desktop', os: 'Windows', browser: 'Firefox' }
    ],
    [
      'Windows Edge',
      { userAgent: UA.winEdge },
      { class: 'desktop', os: 'Windows', browser: 'Edge' }
    ],
    [
      'Linux Chrome',
      { userAgent: UA.linuxChrome },
      { class: 'desktop', os: 'Linux', browser: 'Chrome' }
    ],
    [
      'ChromeOS',
      { userAgent: UA.chromebook },
      { class: 'desktop', os: 'ChromeOS', browser: 'Chrome' }
    ],
    [
      'Client hints win over the UA string',
      {
        userAgent: UA.linuxChrome,
        uaDataPlatform: 'Android',
        uaDataBrands: ['Not=A?Brand', 'Chromium', 'Google Chrome'],
        uaDataMobile: true,
        coarsePointer: true,
        maxTouchPoints: 5,
        screenShortSide: 400
      },
      { class: 'phone', os: 'Android', browser: 'Chrome' }
    ],
    ['Nothing recognisable', { userAgent: 'curl/8' }, { class: 'desktop' }]
  ])('%s', (_name, env, expected) => {
    expect(detectDeviceFacts({ ...base, ...env } as DeviceEnv)).toEqual(expected);
  });
});

describe('touchDeviceRecord', () => {
  const db = new HistoryDexie('history_device_test');
  afterEach(async () => {
    await db.devices.clear();
  });

  it('keeps first_seen and moves last_seen', async () => {
    const facts = { class: 'phone' as const, os: 'Android', browser: 'Chrome' };
    const first = await touchDeviceRecord(db, facts, '2026-10-01T00:00:00.000Z');
    const second = await touchDeviceRecord(db, facts, '2026-10-02T00:00:00.000Z');
    expect(second.device).toBe(first.device);
    expect(second.first_seen).toBe('2026-10-01T00:00:00.000Z');
    expect(second.last_seen).toBe('2026-10-02T00:00:00.000Z');
    expect(await db.devices.count()).toBe(1);
  });
});
