/**
 * `positions.json` IO: read every listed copy, adopt newer positions from
 * other devices, write this device's own. Runs inside every full sync, as a
 * debounced push after page turns, and as a check when the reader opens.
 *
 * Never fatal: every failure is logged and reported as an outcome, so the
 * surrounding sync (or the reader's open) carries on. The file is not
 * authoritative — the history events and `volume-data.json` still carry
 * every position — which is also why it may go through the blind upload.
 */

import { get, type Readable } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { devices } from '$lib/reading-history/device-stats';
import { historyDb } from '$lib/reading-history/history-db';
import { offerDeviceName } from '$lib/reading-history/position-offer';
import { getOrCreateDeviceId } from '$lib/reading-history/record';
import {
  adoptPosition,
  registerPositionListener,
  volumesWithTrash
} from '$lib/settings/volume-data';
import { showSnackbar } from '$lib/util/snackbar';
import { isVolumeComplete } from '$lib/util/volume-helpers';
import { cacheManager } from '$lib/util/sync/cache-manager';
import { uploadCacheEntry } from '$lib/util/sync/cloud-cache-interface';
import { syncReady } from '$lib/util/sync/foreground-sync';
import type { CloudFileMetadata, SyncProvider } from '$lib/util/sync/provider-interface';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import {
  POSITIONS_FILE_NAME,
  composePositionsFile,
  mergePositions,
  parsePositionsFile,
  positionsContent,
  type PositionsMap
} from './positions-file';
import { positionsReadAllowed, positionsWriteAllowed } from './positions-capability';
import { clearChanged, ownChangedEntries } from './positions-local';
import { reconcilePositions, type LocalPosition } from './positions-reconcile';
import { noteReaderOpened, openReader } from './reader-open';

export interface PositionsSyncOutcome {
  adopted: string[];
  deferred: string[];
  uploaded: boolean;
  skipped?: 'not-allowed' | 'not-ready';
}

const PUSH_DEBOUNCE_MS = 3000;

/** How long the reader waits for the position check before it opens anyway. */
export const READER_OPEN_WAIT_MS = 1000;

/** At most one focus-triggered check per this long. */
const FOCUS_CHECK_INTERVAL_MS = 10_000;

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: string }).code === 'NOT_FOUND') return true;
  return /not found|404|ENOENT/i.test(error.message);
}

async function readJson(blob: Blob): Promise<unknown> {
  try {
    return JSON.parse(await blob.text());
  } catch {
    return undefined; // an unparseable copy: read, but says nothing
  }
}

function localPosition(volume: string): LocalPosition | undefined {
  const record = get(volumesWithTrash)[volume];
  if (!record) return undefined;
  const stamp = Date.parse(record.lastProgressUpdate);
  const forgotAt = record.forgotAt ? Date.parse(record.forgotAt) : 0;
  return {
    stamp: Number.isNaN(stamp) ? 0 : stamp,
    deleted: !!record.deletedOn,
    forgotAt: Number.isNaN(forgotAt) ? 0 : forgotAt
  };
}

/** Device views for the toast's name; kept warm by `initPositionPush`. */
let deviceViews: Readable<ReadonlyMap<string, unknown>> | null = null;
let deviceViewsValue: ReadonlyMap<string, unknown> = new Map();

function deviceLabel(device: string): string | null {
  const views = deviceViews ? deviceViewsValue : get(devices);
  return offerDeviceName(
    { device, ownDevice: false },
    views as Parameters<typeof offerDeviceName>[1]
  );
}

async function upload(provider: SyncProvider, next: PositionsMap): Promise<void> {
  const blob = new Blob([JSON.stringify(composePositionsFile(next))], {
    type: 'application/json'
  });
  // The blind path skips the post-upload re-listing (Drive refetches the whole
  // tree after every upload). It writes to the ACTIVE provider, so a sync of
  // any other provider takes the ordinary upload.
  const fileId =
    unifiedCloudManager.getActiveProvider()?.type === provider.type
      ? await unifiedCloudManager.blindUploadFile(POSITIONS_FILE_NAME, blob)
      : (await provider.uploadFile(POSITIONS_FILE_NAME, blob)).fileId;
  cacheManager
    .getCache(provider.type)
    ?.add?.(
      POSITIONS_FILE_NAME,
      uploadCacheEntry(provider.type, POSITIONS_FILE_NAME, blob.size, { fileId })
    );
}

async function runSync(provider: SyncProvider): Promise<PositionsSyncOutcome> {
  const outcome: PositionsSyncOutcome = { adopted: [], deferred: [], uploaded: false };
  try {
    const status = provider.getStatus();
    // On bunko the path is a SHARED library file until the server says it
    // keeps it per user: not even a read.
    if (!positionsReadAllowed(status)) return { ...outcome, skipped: 'not-allowed' };

    const files: CloudFileMetadata[] =
      cacheManager.getCache(provider.type)?.getAll(POSITIONS_FILE_NAME) ?? [];
    // A listed copy can be a ghost (deleted, still cached): not-found copies are
    // ignored. Any other failure means a copy we could not see — adopt from the
    // rest, but do not overwrite what we could not read.
    const downloads = await Promise.allSettled(
      files.map(async (file) => readJson(await provider.downloadFile(file)))
    );
    const unreadable = downloads.some(
      (result) => result.status === 'rejected' && !isNotFound(result.reason)
    );
    const readable = downloads
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      .map((r) => r.value);

    const now = Date.now();
    let cloud: PositionsMap = {};
    for (const raw of readable) cloud = mergePositions(cloud, parsePositionsFile(raw, now));
    const cloudContent = readable.length ? positionsContent(readable[0]) : '';

    const ownDevice = await getOrCreateDeviceId(historyDb());
    const own = ownChangedEntries(ownDevice);
    const plan = reconcilePositions({
      cloud,
      cloudContent,
      local: localPosition,
      own,
      ownDevice,
      open: openReader(),
      now
    });

    for (const { volume, entry, toast } of plan.adopt) {
      // Only the open volume's completion is judged here: a catalog row read
      // (thumbnail and all) per entry would eat the reader's 1000 ms wait on a
      // device picked up with a full file. A closed volume keeps its flag;
      // volume-data.json brings the other device's `completed` with it.
      const open = volume === openReader()?.volume;
      const row = open ? await db.volumes.get(volume).catch(() => undefined) : undefined;
      const completed = row?.page_count ? isVolumeComplete(entry.page, row.page_count) : undefined;
      if (!adoptPosition(volume, entry.page, entry.chars, completed, entry.t)) continue;
      outcome.adopted.push(volume);
      if (toast) {
        const name = deviceLabel(entry.device);
        showSnackbar(`Continued from ${name ?? 'another device'}, p.${entry.page}`);
      }
    }
    outcome.deferred = plan.deferred;

    if (unreadable) return outcome;
    if (!plan.upload) {
      // The cloud already holds these positions (or newer): nothing to push.
      clearChanged(own);
      return outcome;
    }
    if (!positionsWriteAllowed(status)) return outcome;
    await upload(provider, plan.next);
    outcome.uploaded = true;
    clearChanged(own);
    return outcome;
  } catch (error) {
    console.warn('[positions] sync failed:', error);
    return outcome;
  }
}

let running: Promise<PositionsSyncOutcome> | null = null;
let followUp: Promise<PositionsSyncOutcome> | null = null;

/**
 * Single-flight. A call while a run is in flight folds into ONE follow-up and
 * gets ITS result: the follow-up starts after the call, so it sees the reader
 * that just opened and the turn that was just made.
 */
export function syncPositions(provider: SyncProvider): Promise<PositionsSyncOutcome> {
  if (!running) {
    running = runSync(provider).finally(() => {
      running = null;
    });
    return running;
  }
  if (!followUp) {
    followUp = running.then(() => {
      followUp = null;
      return syncPositions(provider);
    });
  }
  return followUp;
}

/** Push this device's changed positions now, when a provider is ready. */
export async function flushPositionPush(): Promise<void> {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider || !syncReady()) return;
  await syncPositions(provider);
}

/**
 * The device-swap check: note the open volume, then ask the cloud. Resolves on
 * the answer or after `wait`, whichever is first, so the reader never waits
 * longer. A late answer still lands: the reconcile adopts it (with a toast)
 * while no page has been turned here, and leaves it to the offer after.
 */
export function checkPositionsOnOpen(
  volume: string,
  wait: number = READER_OPEN_WAIT_MS
): Promise<void> {
  noteReaderOpened(volume);
  try {
    const provider = unifiedCloudManager.getActiveProvider();
    if (!provider || !syncReady()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      void syncPositions(provider).finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (error) {
    // The reader waits on this: it must open, whatever went wrong.
    console.warn('[positions] open check failed:', error);
    return Promise.resolve();
  }
}

let lastFocusCheck = -Infinity;

/** Re-check when the app returns to the foreground; throttled to once per 10 s. */
export function requestPositionCheck(now: number = Date.now()): void {
  if (now - lastFocusCheck < FOCUS_CHECK_INTERVAL_MS) return;
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider || !syncReady()) return;
  lastFocusCheck = now;
  void syncPositions(provider);
}

/**
 * Push after page turns settle (3 s), and at once when the tab is hidden — a
 * device put down mid-volume is exactly the one whose position the next device
 * needs. Returns the cleanup.
 */
export function initPositionPush(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    void flushPositionPush();
  };
  const stopListening = registerPositionListener(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, PUSH_DEBOUNCE_MS);
  });
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
    // Back in the foreground: another device may have read on meanwhile.
    else if (document.visibilityState === 'visible') requestPositionCheck();
  };
  document.addEventListener('visibilitychange', onVisibility);
  deviceViews = devices as Readable<ReadonlyMap<string, unknown>>;
  const stopDevices = deviceViews.subscribe((value) => (deviceViewsValue = value));
  return () => {
    if (timer) clearTimeout(timer);
    stopListening();
    stopDevices();
    deviceViews = null;
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export function _resetPositionsSyncForTests(): void {
  running = null;
  followUp = null;
  lastFocusCheck = -Infinity;
}
