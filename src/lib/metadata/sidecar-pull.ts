import { buildPageCharCounts, decodeMokuroSidecar } from '$lib/catalog/cloud-ocr-upgrade';
import { parseMokuroFile } from '$lib/import/processing';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import type { CloudFileMetadata, SyncProvider } from '$lib/util/sync/provider-interface';
import { isArchiveSize, type SeriesFileVolume } from './series-file';

/**
 * The sidecar PULL primitives, and the one budget every pull shares.
 *
 * Its own leaf so both of its consumers can depend on it without depending on
 * each other: `series-backfill.ts` (a whole-series pass) and
 * `cover-service.ts` (a single archive, pulled because a bare placeholder was
 * scrolled into view). These used to live in the backfill, which the cover
 * service imported directly — and once the backfill's stale-cover refresh
 * became a request to the cover service, that direct edge was a two-file
 * cycle, and a partially-mocked backfill inside it resolved to the wrong
 * instance under test. Nothing here imports either of them.
 */

/**
 * How many series' worth of expensive backfill work (volumes scan, pulls,
 * write) may run at once, across every series — and the same pool a
 * render-demand single-archive pull draws from: "fast browsing can't stampede
 * a provider" applies to a .mokuro pull triggered by scrolling past a bare
 * placeholder exactly as much as one triggered by a reconcile sweep. One
 * budget, not two. Mirrors `WRITE_CONCURRENCY`; see `series-backfill.ts`'s
 * module doc for why it is a SEPARATE pool from that one.
 */
const BACKFILL_PASS_CONCURRENCY = 2;
let activeBackfillPasses = 0;
const waitingBackfillPasses: Array<() => void> = [];

export function acquireBackfillSlot(): Promise<void> {
  if (activeBackfillPasses < BACKFILL_PASS_CONCURRENCY) {
    activeBackfillPasses += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitingBackfillPasses.push(() => {
      activeBackfillPasses += 1;
      resolve();
    });
  });
}

export function releaseBackfillSlot(): void {
  activeBackfillPasses -= 1;
  waitingBackfillPasses.shift()?.();
}

/** Test hook: release every slot and forget every waiter. */
export function _resetBackfillSlotsForTests(): void {
  activeBackfillPasses = 0;
  waitingBackfillPasses.length = 0;
}

/**
 * Zero-count entry for an archive with no `.mokuro` sidecar at all.
 *
 * NOT an image-only claim, despite the empty `mokuro_version`. A sidecar-less
 * archive is most often a LEGACY backup whose mokuro is EMBEDDED in the
 * `.cbz` (the whole reason `sidecar-backfill.ts` exists) — nothing can know
 * which until the archive is downloaded. This entry exists only to carry the
 * archive's identity, size and cover stamps, and to stop the backfill pass
 * re-planning the archive on every listing; its zero-content shape is exactly
 * what `hasMeasuredContent` (series-file.ts) reads as "this entry proves
 * nothing", which keeps merges treating it as the weakest possible claim.
 * Consumers that copy a version onto a row or placeholder go through
 * `entryMokuroVersion`: with no cover stamps either (ALL sidecars missing)
 * this shape surfaces as `'unknown'` — never as the image-only `''` — while
 * cover stamps prove a modern backup wrote sidecars without a mokuro, which
 * IS a genuine image-only signal.
 *
 * Used by the backfill for a whole series and by `cover-service.ts`'s
 * render-demand path (decision-tree case 4) for exactly one archive — the
 * SAME entry, not re-derived.
 */
export function buildNoMetadataEntry(
  folderTitle: string,
  archiveStem: string,
  archiveFile: CloudFileMetadata
): SeriesFileVolume {
  const entry: SeriesFileVolume = {
    volume_uuid: generateDeterministicUUID(`${folderTitle}/${archiveStem}`),
    volume_title: archiveStem,
    page_count: 0,
    character_count: 0,
    mokuro_version: ''
  };
  if (isArchiveSize(archiveFile.size)) entry.archive_size = archiveFile.size;
  return entry;
}

/**
 * Download and parse one `.mokuro`/`.mokuro.gz`, building the entry the ENTRY-
 * BUILDING rules describe: `volume_title` from the ARCHIVE's filename stem
 * (never the mokuro's own `title`/`volume` fields — real files get those
 * wrong), `volume_uuid` from the mokuro's own `volume_uuid`, counts measured
 * with the same char math `cloud-ocr-upgrade.ts` uses for its own upgrade
 * path. `undefined` for anything that fails to parse or lacks a usable uuid —
 * the caller treats that as "skip this one volume", never a hard failure.
 *
 * `sidecarFile` is the snapshot the caller already captured from ONE listing
 * read (`groupSeriesSidecarFiles`); it is used here for BOTH the download and
 * the stamp below, so there is no second listing lookup to race a concurrent
 * re-list — the stamp always describes exactly the bytes that were pulled.
 *
 * Used by the backfill pass and by `cover-service.ts`'s render-demand path
 * (decision-tree case 3: a bare placeholder with a real sidecar) — the SAME
 * pull, whether it is triggered by a sweep or by a card scrolled into view.
 */
export async function pullMokuroEntry(
  provider: SyncProvider,
  archiveStem: string,
  sidecarFile: CloudFileMetadata
): Promise<SeriesFileVolume | undefined> {
  const blob = await provider.downloadFile(sidecarFile);
  const decoded = await decodeMokuroSidecar(sidecarFile.path, blob);
  if (!decoded) return undefined;

  const parsed = await parseMokuroFile(decoded);
  if (typeof parsed.volumeUuid !== 'string' || !parsed.volumeUuid.trim()) return undefined;

  const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const { totalChars } = buildPageCharCounts(pages);

  // Base fields only — the caller (`buildEntryForTask`) applies `archive_size`
  // and the stamp fields through `orderVolumeEntryFields` so every entry this
  // module produces re-serializes in the pinned wire order regardless of
  // which fields end up set.
  return {
    volume_uuid: parsed.volumeUuid,
    volume_title: archiveStem,
    page_count: pages.length,
    character_count: totalChars,
    mokuro_version: typeof parsed.version === 'string' ? parsed.version : ''
  };
}
