/**
 * Where reading history lives in the cloud (spec: Storage → Cloud):
 *
 *   history/<device>/device.json        that device's facts
 *   history/<device>/<YYYY-MM>.events   one UTC month of that device's events
 *
 * Exactly three segments, case-sensitive. Anything else is not ours.
 */
export const HISTORY_FOLDER = 'history';
export const DEVICE_FILE_NAME = 'device.json';
/** Page turns converted from `volume-data.json` (phase 2b), uploaded by each converting device. */
export const LEGACY_FILE_NAME = 'legacy.events';
/** Converted turns' events are keyed `legacy:<volume>`, so every device converting them agrees. */
export const LEGACY_DEVICE_PREFIX = 'legacy:';

const MONTH_FILE_RE = /^(\d{4})-(0[1-9]|1[0-2])\.events$/;
const DEVICE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export type HistoryPath =
  | { device: string; kind: 'month'; month: string }
  | { device: string; kind: 'device' }
  | { device: string; kind: 'legacy' };

/** UTC `YYYY-MM`: the same month on every device, whatever its timezone. */
export function historyMonthOf(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function historySegmentPath(device: string, month: string): string {
  return `${HISTORY_FOLDER}/${device}/${month}.events`;
}

export function historyDeviceFilePath(device: string): string {
  return `${HISTORY_FOLDER}/${device}/${DEVICE_FILE_NAME}`;
}

export function historyLegacyFilePath(device: string): string {
  return `${HISTORY_FOLDER}/${device}/${LEGACY_FILE_NAME}`;
}

export function legacyDeviceFor(volume: string): string {
  return `${LEGACY_DEVICE_PREFIX}${volume}`;
}

export function parseHistoryPath(path: string): HistoryPath | null {
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== HISTORY_FOLDER) return null;
  const [, device, name] = parts;
  if (!DEVICE_ID_RE.test(device)) return null;
  if (name === DEVICE_FILE_NAME) return { device, kind: 'device' };
  if (name === LEGACY_FILE_NAME) return { device, kind: 'legacy' };
  const match = MONTH_FILE_RE.exec(name);
  return match ? { device, kind: 'month', month: `${match[1]}-${match[2]}` } : null;
}

export function isHistoryFilePath(path: string): boolean {
  return parseHistoryPath(path) !== null;
}

/** Basename prefilter for listings that see names before paths (Drive, MEGA). */
export function isHistoryFileName(name: string): boolean {
  return name === DEVICE_FILE_NAME || name === LEGACY_FILE_NAME || MONTH_FILE_RE.test(name);
}
