/**
 * `positions.json` IO: read every listed copy, adopt newer positions from
 * other devices, write this device's own. Runs inside every full sync, as a
 * debounced push after page turns, and as a check when the reader opens.
 *
 * Before the listing has loaded — a cold start, the window the file exists
 * for — it runs as the COLD PROBE instead: the provider reads the file by its
 * known path (`readRootFileCopies`, no listing), and the probe only ADOPTS.
 * The write waits for the listing, which is the only thing that can show
 * every copy the upload must not clobber.
 *
 * Never fatal: every failure is logged and reported as an outcome, so the
 * surrounding sync (or the reader's open) carries on. The file is not
 * authoritative — the history events and `volume-data.json` still carry
 * every position — which is also why it may go through the blind upload.
 */

import { get } from 'svelte/store';
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
import { isVolumeComplete, stampMs } from '$lib/util/volume-helpers';
import { cacheManager } from '$lib/util/sync/cache-manager';
import { uploadCacheEntry } from '$lib/util/sync/cloud-cache-interface';
import { noteRootFileUpload, readRootFile } from '$lib/util/sync/root-file-memo';
import { providerTokenValid, syncReady } from '$lib/util/sync/foreground-sync';
import { freshGateStatus } from '$lib/util/sync/identity-gates';
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
import { noteRemoteRead } from '$lib/reading-history/remote-reads';
import { noteUploaded } from './escapes';
import { noteCloudPositions } from './positions-cloud';
import { clearChanged, ownChangedEntries } from './positions-local';
import { reconcilePositions, type LocalPosition } from './positions-reconcile';
import { noteReaderOpened, openReader } from './reader-open';
import { rehomeVisit } from './visit';

export interface PositionsSyncOutcome {
  adopted: string[];
  deferred: string[];
  uploaded: boolean;
  skipped?: 'not-allowed' | 'not-ready';
  /** Ran before the listing: read by path, adopted, wrote nothing. */
  probe?: boolean;
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
  return {
    stamp: stampMs(record.lastProgressUpdate),
    deleted: !!record.deletedOn,
    forgotAt: stampMs(record.forgotAt)
  };
}

/** The toast's device name. Rare (one adoption with a toast), so a read of the derived store is fine. */
function deviceLabel(device: string): string | null {
  return offerDeviceName({ device, ownDevice: false }, get(devices));
}

/** Uploads `next`; resolves to the id of the file the write landed on. */
async function upload(provider: SyncProvider, next: PositionsMap): Promise<string> {
  const blob = new Blob([JSON.stringify(composePositionsFile(next))], {
    type: 'application/json'
  });
  // The manager's upload writes to the ACTIVE provider, so a sync of any
  // other provider uploads through that provider itself. The manager records the
  // upload's receipt in the cache and the read memo itself; the other path
  // records the same receipt here.
  if (unifiedCloudManager.getActiveProvider()?.type === provider.type) {
    return (await unifiedCloudManager.blindUploadFile(POSITIONS_FILE_NAME, blob)).fileId;
  }
  const uploaded = await provider.uploadFile(POSITIONS_FILE_NAME, blob);
  cacheManager
    .getCache(provider.type)
    ?.add?.(
      POSITIONS_FILE_NAME,
      uploadCacheEntry(provider.type, POSITIONS_FILE_NAME, blob.size, uploaded)
    );
  await noteRootFileUpload(provider, POSITIONS_FILE_NAME, blob, uploaded);
  return uploaded.fileId;
}

/**
 * After an upload over several listed copies (Drive lists same-name files;
 * its upload replaces whichever its query returns first): remove every copy
 * the write did not land on, so the next run compares against the one file
 * that holds the merge instead of uploading again forever. A copy already
 * gone (a ghost in the listing, MEGA's replace-by-delete) is converged, not
 * failed; any other failure is logged and left to a later run.
 */
async function removeOtherCopies(
  provider: SyncProvider,
  files: CloudFileMetadata[],
  keptId: string
): Promise<void> {
  if (files.length < 2) return;
  const cache = cacheManager.getCache(provider.type);
  for (const file of files) {
    if (file.fileId === keptId) continue;
    try {
      await provider.deleteFile(file);
      cache?.removeById?.(file.fileId);
    } catch (error) {
      if (isNotFound(error)) cache?.removeById?.(file.fileId);
      else console.warn('[positions] duplicate copy not removed:', error);
    }
  }
}

/** Adopt what the plan says; fills `outcome.adopted` / `deferred`. */
async function applyAdoptions(
  plan: ReturnType<typeof reconcilePositions>,
  outcome: PositionsSyncOutcome
): Promise<void> {
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
    // The other device's page turn: smart sort counts it as reading until
    // that device's own history events arrive and judge it.
    noteRemoteRead(volume, entry.t, entry.device);
    // Adopted before any turn here: the visit's home is the new page.
    if (open) rehomeVisit(volume);
    if (toast) {
      const name = deviceLabel(entry.device);
      showSnackbar(`Continued from ${name ?? 'another device'}, p.${entry.page}`);
    }
  }
  outcome.deferred = plan.deferred;
}

/** Every readable copy, merged; `unreadable` = a copy failed for another reason than not-found. */
async function readCopies(
  reads: Array<() => Promise<Blob>>
): Promise<{ readable: unknown[]; unreadable: boolean }> {
  const downloads = await Promise.allSettled(reads.map(async (read) => readJson(await read())));
  const unreadable = downloads.some(
    (result) => result.status === 'rejected' && !isNotFound(result.reason)
  );
  const readable = downloads
    .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
    .map((r) => r.value);
  return { readable, unreadable };
}

async function planFromCopies(readable: unknown[]) {
  const now = Date.now();
  let cloud: PositionsMap = {};
  for (const raw of readable) cloud = mergePositions(cloud, parsePositionsFile(raw, now));
  const cloudContent = readable.length ? positionsContent(readable[0]) : '';
  const ownDevice = await getOrCreateDeviceId(historyDb());
  const own = ownChangedEntries(ownDevice);
  const result = reconcilePositions({
    cloud,
    cloudContent,
    local: localPosition,
    own,
    ownDevice,
    open: openReader(),
    now
  });
  return { plan: result, own, cloud };
}

/**
 * The cold probe: before the listing, read the file by path and adopt. Never
 * writes, never clears this device's changed marks — the full sync's run,
 * once the listing is in, pushes them against every listed copy.
 */
async function runProbe(
  provider: SyncProvider,
  outcome: PositionsSyncOutcome
): Promise<PositionsSyncOutcome> {
  if (!provider.readRootFileCopies) return { ...outcome, skipped: 'not-ready' };
  if (!provider.isAuthenticated() || !providerTokenValid(provider)) {
    return { ...outcome, skipped: 'not-ready' };
  }
  const copies = await provider.readRootFileCopies(POSITIONS_FILE_NAME);
  const readable = await Promise.all(copies.map(readJson));
  const { plan: result, cloud } = await planFromCopies(readable);
  noteCloudPositions(provider, cloud);
  await applyAdoptions(result, outcome);
  return { ...outcome, probe: true };
}

/**
 * May the probe run now? Only while a listing is under way: listings start
 * after a login has finished, so the provider's per-user gates (bunko's
 * `positionsSync`) are settled — mid-login a bunko still reads as plain
 * WebDAV, and the path would be the SHARED library file.
 */
function probeReady(provider: SyncProvider): boolean {
  if (!provider.readRootFileCopies || !provider.isAuthenticated()) return false;
  if (!providerTokenValid(provider)) return false;
  return cacheManager.getCache(provider.type)?.isFetching() ?? false;
}

async function runSync(
  provider: SyncProvider,
  mode: 'auto' | 'probe' = 'auto'
): Promise<PositionsSyncOutcome> {
  const outcome: PositionsSyncOutcome = { adopted: [], deferred: [], uploaded: false };
  try {
    // The gate must follow the server NOW (a bunko rolled back under an open
    // tab shares this path): the page-turn push and the open/foreground
    // checks run outside the progress sync, so they ask here (throttled).
    const status = await freshGateStatus(provider);
    // On bunko the path is a SHARED library file until the server says it
    // keeps it per user: not even a read.
    if (!positionsReadAllowed(status)) return { ...outcome, skipped: 'not-allowed' };

    // The full sync's step runs for callers the `syncReady()` gate does not
    // cover (the activity tracker, the nav bar, the cloud view, Drive's
    // login). Before the listing has loaded the cache shows no copy, and the
    // upload would replace the cloud file with this device's entries alone:
    // then it is the read-only probe, or nothing.
    const cache = cacheManager.getCache(provider.type);
    if (!cache?.isLoaded() || cache.isFetching()) {
      if (mode === 'probe' || probeReady(provider)) return await runProbe(provider, outcome);
      return { ...outcome, skipped: 'not-ready' };
    }

    const files: CloudFileMetadata[] = cache.getAll(POSITIONS_FILE_NAME) ?? [];
    // A listed copy can be a ghost (deleted, still cached): not-found copies are
    // ignored. Any other failure means a copy we could not see — adopt from the
    // rest, but do not overwrite what we could not read.
    const { readable, unreadable } = await readCopies(
      files.map((file) => () => readRootFile(provider, file))
    );
    const { plan: result, own, cloud } = await planFromCopies(readable);
    // What the cloud holds now, for the volume-data upload decision of the
    // next sync (`positions-cloud.ts`).
    noteCloudPositions(provider, cloud);
    await applyAdoptions(result, outcome);

    if (unreadable) return outcome;
    if (!result.upload) {
      // The cloud already holds these positions (or newer): nothing to push.
      clearChanged(own);
      return outcome;
    }
    if (!positionsWriteAllowed(status)) return outcome;
    // These stamps leave the device now — reported BEFORE the upload, so a
    // look-up that comes home while the PUT is in flight still beats them.
    for (const [volume, entry] of Object.entries(own)) noteUploaded(volume, entry.t);
    const landedOn = await upload(provider, result.next);
    noteCloudPositions(provider, result.next);
    outcome.uploaded = true;
    clearChanged(own);
    await removeOtherCopies(provider, files, landedOn);
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

/**
 * The cold probe, at the start of a listing that has nothing loaded yet
 * (`fetchAllCloudVolumes`): the listing is the slow part of every sync, and
 * the file exists so a device just picked up knows where it stopped before
 * the user can open a book. A run already in flight answers instead.
 */
export function probePositions(provider: SyncProvider): Promise<PositionsSyncOutcome> {
  if (running) return running;
  running = runSync(provider, 'probe').finally(() => {
    running = null;
  });
  return running;
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
    // Before the listing has loaded, the probe answers (by path, read-only).
    if (!provider || !(syncReady() || probeReady(provider))) return Promise.resolve();
    // A run already in flight (the probe a cold start began) may answer first:
    // its reconcile reads the open reader when its download lands, so it sees
    // this open. The follow-up still runs and catches anything it missed.
    const inFlight = running;
    const next = syncPositions(provider);
    const answer = inFlight ? Promise.race([inFlight, next]) : next;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      void answer.finally(() => {
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
  if (!provider || !(syncReady() || probeReady(provider))) return;
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
  return () => {
    if (timer) clearTimeout(timer);
    stopListening();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export function _resetPositionsSyncForTests(): void {
  running = null;
  followUp = null;
  lastFocusCheck = -Infinity;
}
