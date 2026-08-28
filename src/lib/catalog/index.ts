import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import {
  unifiedCloudManager,
  type CloudVolumeWithProvider
} from '$lib/util/sync/unified-cloud-manager';
import {
  cloudFieldsForRemovedVolume,
  generatePlaceholders,
  indexCloudFilesByPath,
  indexCoverFilesByArchiveKey
} from '$lib/catalog/placeholders';
import { routeParams } from '$lib/util/hash-router';
import { getLegacyImageOnlyVolumeUuid } from '$lib/util/download-volume-repair';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { isCatalogVisible } from '$lib/util/cloud-fields';
import { seriesIndexMap, type SeriesIndexRecord } from '$lib/metadata/series-index';
import { seriesMetadataMap } from '$lib/metadata/store';
import { preferredTitleLanguage } from '$lib/settings/settings';
import { isMetadataOnly } from '$lib/catalog/volume-state';

async function loadCurrentVolumeData(volume: VolumeMetadata): Promise<VolumeData | undefined> {
  let [ocr, files] = await Promise.all([
    db.volume_ocr.get(volume.volume_uuid),
    db.volume_files.get(volume.volume_uuid)
  ]);

  if (!ocr || !files) {
    const legacyUuid = getLegacyImageOnlyVolumeUuid(volume);
    if (legacyUuid) {
      const [legacyMetadata, legacyOcr, legacyFiles] = await Promise.all([
        db.volumes.get(legacyUuid),
        db.volume_ocr.get(legacyUuid),
        db.volume_files.get(legacyUuid)
      ]);

      // Repair legacy cloud image-only downloads that stored OCR/files under the
      // old deterministic UUID instead of the canonical placeholder UUID.
      if (!legacyMetadata && (legacyOcr || legacyFiles)) {
        await db.transaction('rw', [db.volume_ocr, db.volume_files], async () => {
          if (!ocr && legacyOcr) {
            ocr = { ...legacyOcr, volume_uuid: volume.volume_uuid };
            await db.volume_ocr.put(ocr);
            await db.volume_ocr.delete(legacyUuid);
          }

          if (!files && legacyFiles) {
            files = { ...legacyFiles, volume_uuid: volume.volume_uuid };
            await db.volume_files.put(files);
            await db.volume_files.delete(legacyUuid);
          }
        });
      }
    }
  }

  if (!ocr) {
    return undefined;
  }

  return {
    volume_uuid: volume.volume_uuid,
    pages: ocr.pages,
    files: files?.files
  };
}

/**
 * A burst of writes must cost ONE recompute, not one per write.
 *
 * Every emission re-derives placeholders, display titles and the sort for the
 * whole library, so an uncoalesced burst pays that repeatedly for a view nobody
 * saw — measured at 74 full recomputes in ten seconds during cover convergence.
 * Trailing-edge on purpose: subscribers get the final state of the burst, and
 * the delay is imperceptible for catalog updates while being long enough to
 * absorb a batch write.
 */
export const VOLUMES_EMISSION_COALESCE_MS = 150;

/**
 * Backoff for the RECOVERY paths below — a rejected read, or a change signal
 * whose liveQuery subscription errored (an errored Rx-style subscription is
 * DEAD: it can never fire again, so without an explicit resubscribe one
 * transient IndexedDB failure at boot would leave `volumes` silently
 * `undefined` forever, which the catalog renders as an infinite "Loading
 * catalog..." spinner). Doubles per failed attempt, capped — a permanently
 * broken backend costs one retried attempt per {@link VOLUMES_RETRY_MAX_MS}
 * rather than a hot loop, and a backend that comes back heals the catalog
 * without a reload.
 *
 * The read and the signal are two INDEPENDENT circuits, each with its own
 * backoff counter (`readRetryDelay` / `signalRetryDelay` below), reset only
 * by that circuit's own proof of health — a successful `toArray()` for the
 * read, the change signal's own `next` firing for the signal. Sharing one
 * counter between them used to let a healthy read reset the backoff for a
 * signal that never recovered: a persistently-broken liveQuery subscription
 * with a perfectly working `toArray()` resubscribed AND rescanned the whole
 * table every {@link VOLUMES_RETRY_BASE_MS}, forever, because each cycle's
 * incidental read success reset the one shared delay back to base before it
 * could ever double.
 */
export const VOLUMES_RETRY_BASE_MS = 1000;
export const VOLUMES_RETRY_MAX_MS = 30000;

// Single source of truth from the database. `undefined` until the first
// coalesced emission lands — never `{}` — so a genuinely-loading catalog is
// distinguishable from a genuinely-empty one; see `volumesWithPlaceholders`
// and `catalog`'s loading guards below, which both depend on this.
export const volumes = readable<Record<string, VolumeMetadata> | undefined>(undefined, (set) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirty = false;
  let disposed = false;
  // Two independent backoff counters — see the doc comment on
  // VOLUMES_RETRY_BASE_MS above for why they must not share one delay.
  let readRetryDelay = VOLUMES_RETRY_BASE_MS;
  let signalRetryDelay = VOLUMES_RETRY_BASE_MS;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let signalDead = false;

  /**
   * The expensive read, run at most once per quiet period.
   *
   * `liveQuery` re-executes its querier on EVERY mutation, so putting
   * `db.volumes.toArray()` inside one means a burst of writes costs a full
   * scan each — measured at 145 scans in 20 seconds on a large library, with
   * later scans queueing behind earlier ones until they reported 16 seconds.
   * The querier below is therefore only a CHANGE SIGNAL; this is the read.
   */
  const runQuery = async () => {
    if (running) {
      // A mutation landed while we were reading: the result we are about to
      // deliver is already stale, so schedule one more pass rather than
      // dropping it.
      dirty = true;
      return;
    }
    running = true;
    try {
      const rows = await db.volumes.toArray();
      // `set` is the SAME function across every start/stop generation of this
      // readable — `readable`'s start callback re-runs on each 0→1 subscriber
      // transition (e.g. the hash router swapping views), but it never gets a
      // fresh `set`. Tearing down a subscription can only clear a PENDING
      // timer and unsubscribe the count signal below; it cannot abort a read
      // that is already awaiting `toArray()`. Without this check, a stale
      // read from a torn-down subscription can resolve after a fresher
      // subscription has already delivered current data and silently
      // clobber it — e.g. a just-imported volume vanishing from the catalog
      // until some unrelated write happens to trigger another scan.
      if (disposed) return;
      // A successful read proves the READ path is healthy again: its own
      // backoff starts over from the base for the next incident. This must
      // NOT touch `signalRetryDelay` — an unrelated read succeeding is not
      // proof the change signal recovered (see the doc comment above
      // VOLUMES_RETRY_BASE_MS); only that circuit's own `next` firing
      // resets it, in `subscribeChangeSignal` below. Gating on `!signalDead`
      // is belt-and-suspenders: nothing in the recovery path calls
      // `runQuery` while the signal is still dead (finding 2's fix removed
      // that call), but the `dirty` re-schedule below is not itself
      // signal-gated, so this keeps the read backoff's reset scoped to a
      // read that actually happened while the read circuit — not the
      // signal circuit — was the one being recovered.
      if (!signalDead) {
        readRetryDelay = VOLUMES_RETRY_BASE_MS;
      }
      set(
        rows.reduce(
          (acc, vol) => {
            acc[vol.volume_uuid] = vol;
            return acc;
          },
          {} as Record<string, VolumeMetadata>
        )
      );
    } catch (err) {
      // A rejected read must not strand the store: before this retry existed,
      // one transient failure of the FIRST read (nothing else writes, so no
      // change signal ever re-fires) froze the catalog on its loading
      // spinner for the rest of the session.
      console.error('[catalog] volumes read failed; will retry:', err);
      scheduleRecovery();
    } finally {
      running = false;
      // A disposed store must not resurrect itself by scheduling more work —
      // see the `disposed` check above `set` for why the flag exists at all.
      if (dirty && !disposed) {
        dirty = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        void runQuery();
      }, VOLUMES_EMISSION_COALESCE_MS);
  };

  /**
   * One recovery timer, but it drives one of two DISJOINT paths depending on
   * which circuit is broken when it fires:
   *
   * - signal dead: resubscribe, and STOP — do not also call `runQuery`
   *   directly. The fresh subscription fires its own initial `next` (Dexie
   *   fires once immediately on subscribe, the same as a real recovery), and
   *   that `next` is what schedules the coalesced read. Calling `runQuery`
   *   here too used to mean every signal recovery paid for two scans instead
   *   of one.
   * - signal alive (a pure read failure): retry the read directly — there is
   *   no subscription to rebuild, and no `next` coming to schedule one.
   *
   * The delay it schedules at, and the counter it doubles, are chosen by the
   * SAME distinction (`signalDead` at the moment this is called, which is
   * always set before the caller invokes it — see the `error` handlers
   * above and below), so a persistently-broken signal keeps doubling its own
   * delay to the cap even while the read circuit stays perfectly healthy.
   */
  const scheduleRecovery = () => {
    if (disposed || recoveryTimer) return;
    const recoveringSignal = signalDead;
    recoveryTimer = setTimeout(
      () => {
        recoveryTimer = null;
        if (disposed) return;
        if (signalDead) {
          signalDead = false;
          subscribeChangeSignal();
        } else {
          void runQuery();
        }
      },
      recoveringSignal ? signalRetryDelay : readRetryDelay
    );
    if (recoveringSignal) {
      signalRetryDelay = Math.min(signalRetryDelay * 2, VOLUMES_RETRY_MAX_MS);
    } else {
      readRetryDelay = Math.min(readRetryDelay * 2, VOLUMES_RETRY_MAX_MS);
    }
  };

  /**
   * `count()` touches the whole store, so Dexie re-fires it on any mutation
   * in the table — including an update, which a key-list query would miss —
   * and it costs an index count rather than deserializing every row and its
   * thumbnail blob.
   */
  let subscription: { unsubscribe: () => void } | null = null;
  const subscribeChangeSignal = () => {
    subscription = liveQuery(() => db.volumes.count()).subscribe({
      next: () => {
        // The signal firing at all — including the resubscribed liveQuery's
        // own initial emission — is the only genuine proof THIS circuit is
        // alive again: reset its backoff here, not on an unrelated read's
        // success (see the doc comment above VOLUMES_RETRY_BASE_MS).
        signalRetryDelay = VOLUMES_RETRY_BASE_MS;
        schedule();
      },
      error: (err) => {
        console.error('[catalog] volumes change signal failed; will resubscribe:', err);
        signalDead = true;
        scheduleRecovery();
      }
    });
  };
  subscribeChangeSignal();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    subscription?.unsubscribe();
  };
});

/**
 * What the placeholder pass actually consumes from the cached indexes: which
 * series have one, and whether it has been re-fetched since (`fetched_at` is
 * bumped by every `putSeriesIndex`). `seriesIndexMap` is a Dexie liveQuery, so
 * it re-emits a brand-new Map of brand-new row objects on ANY write to the
 * table — reference comparison would never hold, and rebuilding the placeholder
 * set per write would re-run the whole cloud scan (plus its OCR-upgrade side
 * effects) for a series the user is not even looking at.
 */
function seriesIndexSignature(map: Map<string, SeriesIndexRecord>): string {
  const parts: string[] = [];
  for (const [key, record] of map) parts.push(`${key}\u0000${record.fetched_at}`);
  parts.sort();
  return parts.join('');
}

let lastPlaceholderInputs: {
  volumes: unknown;
  cloudFiles: unknown;
  indexSignature: string;
} | null = null;
let lastPlaceholders: VolumeMetadata[] = [];

/**
 * The listing's archives (and their cover sidecars) by path, rebuilt only
 * when the listing itself changes. The catalog re-derives on every
 * settings-adjacent emission; re-indexing a few thousand cloud files each
 * time would be pure waste.
 */
let lastCloudFiles: unknown = null;
let lastCloudIndex = new Map<string, CloudVolumeWithProvider>();
let lastCoverIndex = new Map<string, CloudVolumeWithProvider>();

/**
 * Merge local volumes with cloud placeholders.
 *
 * NO COVER INPUT, DELIBERATELY. This derived used to join `cloudCoverMap` — a
 * liveQuery that re-materialised every `cloud_covers` row, blobs and all, on
 * every commit to that table. During cover ingest on a 1,027-series library
 * that meant 3,886 MB deserialized in 59 s, every emission genuinely different
 * (so the signature guard paid its O(N log N) and recomputed anyway), ~4,347
 * FRESH placeholder objects minted per cover, and all 1,027 mounted cards
 * re-rendering for a change that could not alter grouping or order. Measured
 * worst main-thread long task: 1,784 ms. Freezing just this re-derive — same
 * writes, same reads — dropped it to 122 ms.
 *
 * So a cover landing now has NO path into this function. Cover bytes reach the
 * one card that wants them through `cover-resolver.ts`'s keyed per-path read
 * (`CatalogItem`, `CatalogListItem`, `PlaceholderThumbnail`,
 * `SeriesSpineShowcase`), and `cloud-covers-store.ts` carries only KEYS, to
 * tell that resolver a held path has acquired a cover. Do not add a cover
 * store back to this input list.
 */
export const volumesWithPlaceholders = derived(
  [volumes, unifiedCloudManager.cloudFiles, seriesIndexMap],
  ([$volumes, $cloudFiles, $seriesIndexMap]) => {
    // `volumes` is `undefined` until its first coalesced emission lands.
    // Propagate that instead of treating it as `{}`, so `catalog`'s loading
    // guard below can actually fire — otherwise every fresh mount (app boot,
    // and every navigation, since the router tears down and rebuilds this
    // subscription chain per route) would render as a genuinely empty
    // library for the length of one coalesce window.
    if ($volumes === undefined) {
      return undefined;
    }

    const combined = { ...$volumes };
    const localVolumes = Object.values($volumes);

    // Generate cloud provider placeholders
    if ($cloudFiles.size > 0) {
      const indexSignature = seriesIndexSignature($seriesIndexMap);
      if (
        !lastPlaceholderInputs ||
        lastPlaceholderInputs.volumes !== $volumes ||
        lastPlaceholderInputs.cloudFiles !== $cloudFiles ||
        lastPlaceholderInputs.indexSignature !== indexSignature
      ) {
        lastPlaceholders = generatePlaceholders($cloudFiles, localVolumes, $seriesIndexMap);
        lastPlaceholderInputs = {
          volumes: $volumes,
          cloudFiles: $cloudFiles,
          indexSignature
        };
      }

      for (const placeholder of lastPlaceholders) {
        combined[placeholder.volume_uuid] = placeholder;
      }

      // A metadata-only row shadows the placeholder its cloud file would have
      // produced (a path with a local row is not "cloud only"), so it has to be
      // given the same cloud fields here or there would be nothing to download
      // it from — and, when the listing has one, the same cover-sidecar
      // POINTER a placeholder gets (`cloudThumbnailFileId` and friends), so
      // its cover can be fetched from the catalog grid itself without waiting
      // for its series to be opened. Decorating the copy in the catalog, never
      // the stored row: the fileId belongs to the current listing, not to the
      // volume.
      //
      // A POINTER, NEVER A BLOB. This used to additionally look the row's
      // cached cover up in `cloudCoverMap` and stamp the blob onto the copy,
      // which is one of the two ways a cover reached this derivation at all.
      // The blob now comes from `cover-resolver.ts`, keyed by the `cloudPath`
      // decorated just below — every surface that draws such a row
      // (`CatalogItem`, `CatalogListItem`, `PlaceholderThumbnail`) resolves it
      // for itself. `cover-service.ts` is what stops the removed decoration
      // from turning into a re-download: it consults `cloud_covers` by key
      // before fetching (see `isCachedCoverPath` there).
      if (localVolumes.some(isMetadataOnly)) {
        if (lastCloudFiles !== $cloudFiles) {
          lastCloudIndex = indexCloudFilesByPath($cloudFiles);
          lastCoverIndex = indexCoverFilesByArchiveKey($cloudFiles);
          lastCloudFiles = $cloudFiles;
        }
        for (const vol of localVolumes) {
          if (!isMetadataOnly(vol)) continue;
          const cloudFields = cloudFieldsForRemovedVolume(lastCloudIndex, vol, lastCoverIndex);
          if (!cloudFields) continue;
          combined[vol.volume_uuid] = { ...vol, ...cloudFields };
        }
      }
    }

    return combined;
  },
  undefined as Record<string, VolumeMetadata> | undefined
);

// Each derived store needs to be passed as an array if using multiple inputs.
// Display titles are resolved here (once per recompute) from series metadata +
// the synced preferredTitleLanguage setting; grouping/routing still use series_title.
// Join on the PRIMITIVE language store, never on `catalogSettings`: that object store
// emits a new object on every settings write (per-wheel-tick `pagedGap` included), which
// would re-group, re-resolve and re-sort the whole library each time.
export const catalog = derived(
  [volumesWithPlaceholders, seriesMetadataMap, preferredTitleLanguage],
  ([$volumesWithPlaceholders, $seriesMetadataMap, $preferredTitleLanguage]) => {
    // Return null while loading (before first data emission)
    if ($volumesWithPlaceholders === undefined) {
      return null;
    }
    // The root catalog.json's facts merge into `seriesMetadataMap` (see
    // catalog-index-sync.ts) for search/mapping enrichment of series that
    // exist here or in the cloud listing — it never mints a card of its own
    // (a stale file would otherwise produce dead-end cards for deleted
    // folders).
    //
    // Same rule for retained rows: a metadata-only row the ACTIVE listing did
    // not decorate has nowhere to be downloaded from — its cloud copy was
    // deleted, or sits on a provider that is not connected. It keeps its DB
    // row, thumbnail and history for the stats views, but the catalog does not
    // seat it. The metadata writers are unaffected: they read `db.volumes`
    // directly (series-file-sync.ts), never this display store.
    return deriveSeriesFromVolumes(
      Object.values($volumesWithPlaceholders).filter(isCatalogVisible),
      $seriesMetadataMap,
      $preferredTitleLanguage
    );
  }
);

export const currentSeries = derived([routeParams, catalog], ([$routeParams, $catalog]) => {
  if (!$catalog || !$routeParams.manga) return [];

  const routeKey = normalizeSeriesKey($routeParams.manga);
  // Primary: match by title (folder name) - handles placeholder→local transition
  let series = $catalog.find((s) => normalizeSeriesKey(s.title) === routeKey);

  // Fallback: match by UUID (for legacy URLs)
  if (!series) {
    series = $catalog.find((s) => s.series_uuid === $routeParams.manga);
  }

  return series?.volumes || [];
});

export const currentVolume = derived([routeParams, volumes], ([$routeParams, $volumes]) => {
  if ($routeParams && $volumes && $routeParams.volume) {
    return $volumes[$routeParams.volume]; // Direct lookup instead of find()
  }
  return undefined;
});

export const currentVolumeData: Readable<VolumeData | undefined> = derived(
  [currentVolume],
  ([$currentVolume], set: (value: VolumeData | undefined) => void) => {
    // Track the last volume UUID to avoid unnecessary clears
    // This prevents flash when unrelated volumes are added to the database
    const newUuid = $currentVolume?.volume_uuid;

    // Only clear data when actually navigating to a different volume
    // Don't clear if the store just emitted a new object reference for the same volume
    if (newUuid !== currentVolumeDataLastUuid) {
      currentVolumeDataLastUuid = newUuid;
      // Clear old data synchronously to prevent state leaks between volumes
      set(undefined);
    }

    if ($currentVolume) {
      loadCurrentVolumeData($currentVolume)
        .then((volumeData) => {
          if (volumeData) {
            set(volumeData);
          }
        })
        .catch((error) => {
          console.error('Failed to load current volume data:', error);
        });
    }
  },
  undefined // Initial value
);

// Track last volume UUID to prevent unnecessary data clears
let currentVolumeDataLastUuid: string | undefined;

/**
 * Japanese character count for current volume.
 * Uses page_char_counts from metadata for O(1) lookup when available.
 */
export const currentVolumeCharacterCount = derived(
  [currentVolume, currentVolumeData],
  ([$currentVolume, $currentVolumeData]) => {
    if (!$currentVolume) return 0;

    // Use pre-calculated cumulative char counts from metadata (v3)
    if ($currentVolume.page_char_counts && $currentVolume.page_char_counts.length > 0) {
      // Last element of cumulative array is the total
      return $currentVolume.page_char_counts[$currentVolume.page_char_counts.length - 1];
    }

    // Fallback: calculate from pages if page_char_counts not available
    if ($currentVolumeData && $currentVolumeData.pages) {
      const japaneseRegex =
        /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

      let totalChars = 0;
      for (const page of $currentVolumeData.pages) {
        for (const block of page.blocks) {
          for (const line of block.lines) {
            totalChars += Array.from(line).filter((char) => japaneseRegex.test(char)).length;
          }
        }
      }
      return totalChars;
    }

    return 0;
  }
);
