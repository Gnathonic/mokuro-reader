import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import { isArchiveSize, type CloudSidecarStamp } from './series-file';
import { normalizeVolumeTitleKey } from './series-key';

/**
 * The freshness half of `series-backfill.ts`: turning a cloud folder listing
 * into per-volume `.mokuro`/cover sizes-and-mtimes, and deciding from them
 * whether a `series.json` entry needs rebuilding.
 *
 * Every stamp here comes from the LISTING's own `size`/`modifiedTime` for the
 * sidecar file — never a local stat, never `Date.now()`. That is not a style
 * preference: a local clock would make two devices disagree about whether an
 * entry is stale, and the whole point of the stamp is that every reader of
 * `series.json` (including a device that never pulled anything) can compare it
 * against the SAME listing and get the same answer.
 *
 * The provider cache is ALLOWED to hold entries whose `modifiedTime` is a
 * client-clock fallback (an upload whose response carried no server mtime) —
 * but every such entry is marked `modifiedTimeProvisional`, and
 * {@link stampFromSidecarFiles} refuses to derive a stamp from one: the entry
 * gets NO stamp for that sidecar, which is safe by design ({@link isSidecarStale}
 * treats a stampless entry as adopting the next listing as its baseline). The
 * next full listing replaces the provisional entry with a server-stamped one,
 * and the stamp publishes on the pass after that.
 */

/** The extensions a per-volume cover sidecar can have (mirrors `placeholders.ts`). */
const COVER_EXT_REGEX = /\.(webp|jpe?g)$/i;

/**
 * Would a file with this NAME be recognized as a cover sidecar by the listing
 * groupers (`groupSeriesSidecarFiles` here, `indexCoverSidecarsByBasePath` in
 * `placeholders.ts`)? An uploader must ask THIS predicate before writing a
 * cover next to an archive: a thumbnail whose type maps to any other extension
 * (png, avif, gif) would upload fine and then be invisible to every cover
 * lookup — an orphan the next listing still reports as "cover missing".
 */
export function hasCoverSidecarExtension(name: string): boolean {
  return COVER_EXT_REGEX.test(name);
}

/** Convert an ISO 8601 timestamp to epoch seconds, truncated (never rounded). */
export function isoToEpochSeconds(iso: string | undefined | null): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return Math.trunc(ms / 1000);
}

/** One volume's raw sidecar files, captured from ONE listing snapshot. */
export interface SeriesSidecarFiles {
  /** Prefers a plain `.mokuro` over `.mokuro.gz` when both are listed. */
  mokuro?: CloudFileMetadata;
  /** Prefers `.webp` over `.jpg`/`.jpeg` when both are listed (same rule as `indexCoverSidecarsByBasePath`). */
  cover?: CloudFileMetadata;
}

function basename(path: string): string {
  return path.split('/').pop() ?? '';
}

/**
 * Group a folder's listing by folded volume title, keeping the raw
 * `CloudFileMetadata` (not just a derived stamp) — so a caller can capture ONE
 * snapshot and use the SAME object to both download the sidecar and stamp the
 * entry it builds from it. Re-deriving the stamp from a fresh listing between
 * "decide to pull" and "stamp the entry" is exactly what this shape prevents:
 * there is no second lookup to accidentally perform.
 *
 * `files` should already be scoped to the one series folder (e.g. the result
 * of `unifiedCloudManager.getCloudVolumesBySeries(folderTitle)`) — nothing
 * here re-checks the folder.
 */
export function groupSeriesSidecarFiles(
  files: Iterable<CloudFileMetadata>
): Map<string, SeriesSidecarFiles> {
  const groups = new Map<string, SeriesSidecarFiles>();

  for (const file of files) {
    const name = basename(file.path);
    let stem: string | undefined;
    let kind: 'mokuro' | 'mokuro-gz' | 'cover' | undefined;

    if (/\.mokuro\.gz$/i.test(name)) {
      stem = name.slice(0, -'.mokuro.gz'.length);
      kind = 'mokuro-gz';
    } else if (/\.mokuro$/i.test(name)) {
      stem = name.slice(0, -'.mokuro'.length);
      kind = 'mokuro';
    } else {
      const match = name.match(COVER_EXT_REGEX);
      if (match) {
        stem = name.slice(0, -match[0].length);
        kind = 'cover';
      }
    }
    if (!stem || !kind) continue;

    const key = normalizeVolumeTitleKey(stem);
    if (!key) continue;
    const entry = groups.get(key) ?? {};

    if (kind === 'cover') {
      const isWebp = name.toLowerCase().endsWith('.webp');
      if (!entry.cover || isWebp) entry.cover = file;
    } else if (!entry.mokuro || kind === 'mokuro') {
      // Plain `.mokuro` wins over `.mokuro.gz` when both are present.
      entry.mokuro = file;
    }
    groups.set(key, entry);
  }

  return groups;
}

/**
 * Derive a `CloudSidecarStamp` from ONE captured `SeriesSidecarFiles` snapshot.
 *
 * A file flagged `modifiedTimeProvisional` — an upload-time cache entry whose
 * provider returned no server mtime, stamped with the CLIENT clock — yields NO
 * fields at all for that sidecar. Publishing its client time would make the
 * next real listing's server mtime look "newer" and re-pull a file this device
 * itself just wrote; publishing nothing is safe because a stampless entry
 * adopts the next listing as its baseline (see {@link isSidecarStale}).
 */
export function stampFromSidecarFiles(files: SeriesSidecarFiles | undefined): CloudSidecarStamp {
  const stamp: CloudSidecarStamp = {};
  if (files?.mokuro && !files.mokuro.modifiedTimeProvisional) {
    if (isArchiveSize(files.mokuro.size)) stamp.mokuro_size = files.mokuro.size;
    const modified = isoToEpochSeconds(files.mokuro.modifiedTime);
    if (modified !== undefined) stamp.mokuro_modified = modified;
  }
  if (files?.cover && !files.cover.modifiedTimeProvisional) {
    if (isArchiveSize(files.cover.size)) stamp.cover_size = files.cover.size;
    const modified = isoToEpochSeconds(files.cover.modifiedTime);
    if (modified !== undefined) stamp.cover_modified = modified;
  }
  return stamp;
}

/**
 * `buildSeriesFile`'s `cloudSidecarStamps` argument, for the whole folder in
 * one pass: every volume the listing shows a `.mokuro`/cover sidecar for, keyed
 * by folded title. A volume with neither is simply absent from the map.
 */
export function buildCloudSidecarStamps(
  files: Iterable<CloudFileMetadata>
): Map<string, CloudSidecarStamp> {
  const groups = groupSeriesSidecarFiles(files);
  const stamps = new Map<string, CloudSidecarStamp>();
  for (const [key, group] of groups) {
    const stamp = stampFromSidecarFiles(group);
    if (Object.keys(stamp).length > 0) stamps.set(key, stamp);
  }
  return stamps;
}

/**
 * Is a stamped field stale against the listing's current sidecar?
 *
 * - No sidecar in the listing at all → never stale: nothing to compare
 *   against and nothing to (re)fetch.
 * - The entry carries NO stamp at all (written by pre-stamp code — in
 *   practice EVERY entry a library accumulated before this scheme existed) →
 *   never stale. The entry ADOPTS the current listing as its baseline
 *   instead of being pulled: a stamp is listing metadata (size/mtime), not
 *   file content, and a stampless entry already carries the real data
 *   (uuid, counts) a pull would produce — re-downloading the mokuro to learn
 *   its own size gains zero information. The stamp attaches organically the
 *   next time ANY write touches this entry (an installed row's own write
 *   stamps it via `buildCloudSidecarStamps`; a genuinely-pulled entry for
 *   the SAME series carries every other entry through unchanged); until
 *   then it stays unstamped, which costs nothing.
 *
 *   (DECIDED 2026-08-24, field regression: the previous "stampless + listed
 *   = stale, heal once" rule is a library-wide pull storm in practice — a
 *   197-series library upgrading from pre-stamp code queued ~1800 multi-MB
 *   pulls in one pass, starving the catalog's own cover fetches on the same
 *   provider connection until cards went blank. Never bring back heal-once
 *   without a rate limit that accounts for a whole-library migration.)
 * - Otherwise (the entry DOES carry a stamp): stale when the size differs,
 *   or when the listing's mtime is STRICTLY newer than the stored one.
 *   Equal-or-older mtime with an equal size is never stale — a provider
 *   whose mtimes drift backwards or repeat must not cause a re-pull loop.
 */
export function isSidecarStale(
  entryStamp: { size?: number; modified?: number },
  listingStamp: { size?: number; modified?: number } | undefined
): boolean {
  if (!listingStamp) return false;
  // A listing stamp with NEITHER field carries no information to compare
  // against — it happens when the listed sidecar is a provisional upload-time
  // cache entry (`stampFromSidecarFiles` withholds every field for those).
  // Treat it like "no sidecar listed": never stale, never a re-pull of a file
  // this device just wrote.
  const hasListingStamp = listingStamp.size !== undefined || listingStamp.modified !== undefined;
  if (!hasListingStamp) return false;
  const hasEntryStamp = entryStamp.size !== undefined || entryStamp.modified !== undefined;
  if (!hasEntryStamp) return false;
  if (entryStamp.size !== listingStamp.size) return true;
  if (
    listingStamp.modified !== undefined &&
    entryStamp.modified !== undefined &&
    listingStamp.modified > entryStamp.modified
  ) {
    return true;
  }
  return false;
}
