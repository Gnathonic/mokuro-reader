import type { HistoryDexie } from './history-db';
import { getOrCreateDeviceId } from './record';
import type { DeviceClass, DeviceFacts } from './types';

/**
 * Coarse signals only: class, OS family, browser family. Never a device model
 * or the full user agent. Laptop vs desktop can't be told apart reliably from
 * a browser, so fine-pointer devices report 'desktop' and the user corrects it
 * (phase 4 labels).
 */
export interface DeviceEnv {
  userAgent: string;
  uaDataPlatform?: string;
  uaDataBrands?: string[];
  uaDataMobile?: boolean;
  coarsePointer: boolean;
  maxTouchPoints: number;
  /** min(screen.width, screen.height) in CSS px. */
  screenShortSide: number;
}

interface UADataLike {
  platform?: string;
  brands?: { brand: string }[];
  mobile?: boolean;
}

export function readDeviceEnv(): DeviceEnv {
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  return {
    userAgent: navigator.userAgent,
    uaDataPlatform: uaData?.platform || undefined,
    uaDataBrands: uaData?.brands?.map((b) => b.brand),
    uaDataMobile: uaData?.mobile,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    screenShortSide: Math.min(screen.width, screen.height)
  };
}

const PHONE_MAX_SHORT_SIDE = 600;

export function detectDeviceFacts(env: DeviceEnv): {
  class: DeviceClass;
  os?: string;
  browser?: string;
} {
  const os = detectOs(env);
  const browser = detectBrowser(env);
  return { class: detectClass(env, os), ...(os && { os }), ...(browser && { browser }) };
}

function isIpadDesktopUa(env: DeviceEnv): boolean {
  // iPadOS Safari sends a macOS UA; touch points give it away.
  return /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
}

function detectClass(env: DeviceEnv, os: string | undefined): DeviceClass {
  if (env.uaDataMobile === true) return 'phone';
  if (isIpadDesktopUa(env)) return 'tablet';
  if (env.coarsePointer) {
    return env.screenShortSide < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
  }
  if (os === 'Android' || os === 'iOS') {
    return env.screenShortSide < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
  }
  return 'desktop';
}

const PLATFORM_NAMES: Record<string, string> = {
  Android: 'Android',
  iOS: 'iOS',
  Windows: 'Windows',
  macOS: 'macOS',
  Linux: 'Linux',
  'Chrome OS': 'ChromeOS',
  ChromeOS: 'ChromeOS'
};

function detectOs(env: DeviceEnv): string | undefined {
  if (env.uaDataPlatform && PLATFORM_NAMES[env.uaDataPlatform]) {
    return PLATFORM_NAMES[env.uaDataPlatform];
  }
  const ua = env.userAgent;
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua) || isIpadDesktopUa(env)) return 'iOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return undefined;
}

const BRANDS: [string, string][] = [
  ['Microsoft Edge', 'Edge'],
  ['Opera', 'Opera'],
  ['Brave', 'Brave'],
  ['Google Chrome', 'Chrome'],
  ['Chromium', 'Chromium']
];

function detectBrowser(env: DeviceEnv): string | undefined {
  for (const [brand, name] of BRANDS) {
    if (env.uaDataBrands?.includes(brand)) return name;
  }
  const ua = env.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS/.test(ua)) return 'Firefox';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return undefined;
}

/** Create or refresh this device's facts row. `first_seen` never moves. */
export async function touchDeviceRecord(
  db: HistoryDexie,
  facts: ReturnType<typeof detectDeviceFacts>,
  nowIso: string
): Promise<DeviceFacts> {
  const device = await getOrCreateDeviceId(db);
  return db.transaction('rw', db.devices, async () => {
    const existing = await db.devices.get(device);
    const record: DeviceFacts = {
      device,
      ...facts,
      first_seen: existing?.first_seen ?? nowIso,
      last_seen: nowIso
    };
    await db.devices.put(record);
    return record;
  });
}
