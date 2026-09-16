/**
 * The single source of truth for which files sync providers list and cache.
 * Shared by ALL five providers — do not fork per-provider copies again.
 *
 * Categories:
 * - CBZ archives (the volumes themselves)
 * - Sidecars: OCR data (.mokuro / .mokuro.gz), thumbnails (.webp/.jpg/.jpeg)
 *   and the per-series index `<Series Title>/series.json`
 * - Root config files: volume-data.json (read progress + series-level reading
 *   state), profiles.json (settings profiles) and goals.json (reading goals,
 *   closed-period snapshots and per-volume deadlines), plus catalog.json (the
 *   compiled library index)
 *
 * `series.json` is a sidecar of the SERIES FOLDER, not of a volume: it is the
 * only sidecar whose basename does not start with a volume title, so anything
 * pairing sidecars to volumes by `<Series>/<Volume>.<ext>` (the cloud manager's
 * managed-file matcher, the placeholder generator) skips it by construction.
 *
 * libraries.json is deliberately NOT listed: it belonged to the removed
 * libraries feature. Stale copies may still exist in users' cloud folders —
 * keep ignoring them.
 */

import { CATALOG_FILE_NAME, isCatalogFilePath } from '$lib/metadata/catalog-file';
import { SERIES_FILE_NAME, isSeriesFilePath } from '$lib/metadata/series-file';
import { GOALS_FILE_NAME } from '$lib/goals/goals-file';

const ROOT_CONFIG_FILENAMES = new Set([
  'volume-data.json',
  'profiles.json',
  GOALS_FILE_NAME,
  CATALOG_FILE_NAME
]);

// series-metadata.json is deliberately NOT listed: it was retired on 2026-08-23
// before ever shipping (facts moved to <Series>/series.json, reading state to
// volume-data.json's `series` section). A stale copy may still sit in a folder
// somebody synced from a dev build — keep ignoring it, exactly like libraries.json.

const SIDECAR_IMAGE_RE = /\.(webp|jpe?g)$/i;

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

export function isCbzFile(basename: string): boolean {
  return basename.toLowerCase().endsWith('.cbz');
}

export function isSidecarFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  return (
    lower.endsWith('.mokuro') ||
    lower.endsWith('.mokuro.gz') ||
    SIDECAR_IMAGE_RE.test(lower) ||
    // Exact basename, never a suffix match: `my-series.json` is not ours.
    lower === SERIES_FILE_NAME
  );
}

export function isRootConfigFile(basename: string): boolean {
  return ROOT_CONFIG_FILENAMES.has(basename.toLowerCase());
}

export function isSyncableFile(path: string): boolean {
  const basename = basenameOf(path);
  return isCbzFile(basename) || isSidecarFile(basename) || isRootConfigFile(basename);
}

/**
 * Is this path one of the COMPILED metadata files — `<Series>/series.json` or
 * the root `catalog.json`?
 *
 * Writing them is best-effort by contract: on a bunko-backed library the server
 * compiles both, a scoped user's `catalog.json` PUT is rejected outright and a
 * `series.json` PUT is an update *request*. A rejection there says nothing about
 * whether the account can write progress or upload archives, so it must never
 * demote the provider to read-only, never clear stored credentials and never
 * surface UI. Progress (`volume-data.json`) and profiles are deliberately NOT
 * in this set: those are the user's own state, and a silent failure there
 * really is a problem worth surfacing.
 *
 * `catalog.json` only counts at the ROOT — a nested one is somebody else's file.
 *
 * `goals.json` is deliberately NOT here either: no server compiles a user's
 * personal reading goals, so there is nothing for a server to reject by design.
 * It is the user's own state, like progress and profiles, and a silently
 * dropped write there is data loss they never learn about.
 */
export function isBestEffortMetadataPath(path: string): boolean {
  return isSeriesFilePath(path) || isCatalogFilePath(path);
}

/**
 * Alternate OCR layers ride beside a volume as `<Volume Title>.<layer-id>.mokuro`
 * (optionally `.gz`) — the SAME shape mokuro-bunko's multi-engine OCR writes
 * (`Volume 01.paddle-manga.mokuro`), so an engine's output and a reader-made
 * layer are one thing. `layer-id` is a slug of `[a-z0-9-]` and IS the row's
 * `layer_id`.
 *
 * A bare filename cannot say whether `Vol 1.5.mokuro` is the primary of
 * `Vol 1.5.cbz` or layer `5` of `Vol 1.cbz`: {@link classifyMokuroSidecar}
 * decides by ARCHIVE PRESENCE in the same folder listing, and every site that
 * pairs a `.mokuro` with a volume must go through it. {@link splitLayerSidecarName}
 * is the listing-free split for a file arriving on its own (an import, an
 * export name round-trip), where the caller matches the stem itself.
 */
export const LAYER_ID_RE = /^[a-z0-9-]{1,32}$/;

export type MokuroSidecarClass =
  | { kind: 'primary'; stem: string; gz: boolean }
  | { kind: 'layer'; stem: string; layerId: string; gz: boolean }
  | { kind: 'orphan' };

function stripMokuroExtension(basename: string): { base: string; gz: boolean } | null {
  const lower = basename.toLowerCase();
  if (lower.endsWith('.mokuro.gz')) return { base: basename.slice(0, -10), gz: true };
  if (lower.endsWith('.mokuro')) return { base: basename.slice(0, -7), gz: false };
  return null;
}

/** Lowercased archive stems (`Vol 1.cbz` → `vol 1`) of a folder's basenames. */
export function cbzStemsOf(basenames: Iterable<string>): Set<string> {
  const stems = new Set<string>();
  for (const name of basenames) {
    if (isCbzFile(name)) stems.add(name.slice(0, -4).toLowerCase());
  }
  return stems;
}

/**
 * Pure split of `<stem>.<id>.mokuro[.gz]` — null when the file has no dot
 * segment that is a valid layer id (`Vol 1.mokuro`, `Vol 1.Bad_Id.mokuro`).
 * Says nothing about whether `<stem>` is a real volume: see the classifier.
 */
export function splitLayerSidecarName(
  basename: string
): { stem: string; layerId: string; gz: boolean } | null {
  const stripped = stripMokuroExtension(basename);
  if (!stripped) return null;
  const dot = stripped.base.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = stripped.base.slice(0, dot);
  const layerId = stripped.base.slice(dot + 1).toLowerCase();
  if (!LAYER_ID_RE.test(layerId)) return null;
  return { stem, layerId, gz: stripped.gz };
}

/**
 * What a listed `.mokuro` IS, given the archives listed in the same folder:
 * 1. `<full base>.cbz` present → that volume's PRIMARY sidecar;
 * 2. else `<stem>.<id>` with `<stem>.cbz` present and a valid id → LAYER `<id>`
 *    of `<stem>`;
 * 3. else an ORPHAN, ignored exactly as an unmatched `.mokuro` always was.
 * `cbzStems` come from {@link cbzStemsOf} (lowercased).
 */
export function classifyMokuroSidecar(
  basename: string,
  cbzStems: ReadonlySet<string>
): MokuroSidecarClass {
  const stripped = stripMokuroExtension(basename);
  if (!stripped) return { kind: 'orphan' };
  if (cbzStems.has(stripped.base.toLowerCase())) {
    return { kind: 'primary', stem: stripped.base, gz: stripped.gz };
  }
  const split = splitLayerSidecarName(basename);
  if (split && cbzStems.has(split.stem.toLowerCase())) {
    return { kind: 'layer', stem: split.stem, layerId: split.layerId, gz: split.gz };
  }
  return { kind: 'orphan' };
}

export function layerSidecarName(volumeTitle: string, layerId: string): string {
  return `${volumeTitle}.${layerId}.mokuro`;
}
