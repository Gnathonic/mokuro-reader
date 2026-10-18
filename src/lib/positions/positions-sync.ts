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
import { openReader } from './reader-open';

export interface PositionsSyncOutcome {
  adopted: string[];
  deferred: string[];
  uploaded: boolean;
  skipped?: 'not-allowed' | 'not-ready';
}

const PUSH_DEBOUNCE_MS = 3000;

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
      const row = await db.volumes.get(volume).catch(() => undefined);
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
}
