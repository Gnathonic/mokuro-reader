import { writable, type Readable } from 'svelte/store';

/**
 * Volumes whose last cloud upload failed for good (retries spent, or a refusal
 * the server meant). Persisted, so the volume keeps saying so — with a Retry —
 * after the snackbar and the tray line are long gone. Cleared by the next
 * successful upload of that volume. Never set for an export to disk.
 */
export interface UploadFailure {
  volume_uuid: string;
  volume_title: string;
  series_title: string;
  provider: string;
  /** One human sentence: the server's `detail` when it gave one. */
  reason: string;
  /** ISO time of the failure. */
  at: string;
}

const STORAGE_KEY = 'upload-failures:v1';

function isFailure(value: unknown): value is UploadFailure {
  const f = value as UploadFailure;
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.volume_uuid === 'string' &&
    typeof f.volume_title === 'string' &&
    typeof f.series_title === 'string' &&
    typeof f.provider === 'string' &&
    typeof f.reason === 'string' &&
    typeof f.at === 'string'
  );
}

function read(): Record<string, UploadFailure> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, UploadFailure> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isFailure(value) && value.volume_uuid === key) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const store = writable<Record<string, UploadFailure>>(read());

/** volume_uuid → its last upload failure. */
export const uploadFailures: Readable<Record<string, UploadFailure>> = {
  subscribe: store.subscribe
};

function write(next: Record<string, UploadFailure>): void {
  store.set(next);
  try {
    if (Object.keys(next).length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the state lasts this session.
  }
}

let current = read();
store.subscribe((value) => (current = value));

export function recordUploadFailure(
  failure: Omit<UploadFailure, 'at'>,
  when: Date = new Date()
): void {
  write({ ...current, [failure.volume_uuid]: { ...failure, at: when.toISOString() } });
}

export function clearUploadFailure(volumeUuid: string): void {
  if (!(volumeUuid in current)) return;
  const next = { ...current };
  delete next[volumeUuid];
  write(next);
}

/** Tests: reload from storage (or forget it too). */
export function resetUploadFailuresForTest(options: { keepStorage?: boolean } = {}): void {
  if (!options.keepStorage) {
    try {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  store.set(read());
}
