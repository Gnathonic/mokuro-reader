import { db } from '$lib/catalog/db';
import { volumesForFoldedSeriesTitle } from '$lib/catalog/volumes-by-series';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import type { Page, VolumeMetadata, VolumeOcrLayer } from '$lib/types';
import { splitLayerSidecarName } from '$lib/util/sync/syncable-file';
import { layerKindForId, layerNameForId } from './layers';

/**
 * Layer files arriving by hand: a `<title>.<id>.mokuro` picked in the upload
 * modal, dropped beside a volume in a ZIP, or found inside a downloaded
 * archive. Each attaches to the volume it names as layer `<id>` — by the
 * `volume_uuid` inside the file first, else by title — and never creates a
 * volume of its own.
 */

export interface LayerFileEntry {
  /** The file as picked (its `webkitRelativePath` or name). */
  path: string;
  file: File;
}

export interface ExtractedLayerEntry {
  path: string;
  file: File;
  stem: string;
  layerId: string;
  gz: boolean;
  /** Parent directory of the entry (`''` at the root). */
  dir: string;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function sourceStemOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.mokuro.gz')) return name.slice(0, -10);
  if (lower.endsWith('.mokuro')) return name.slice(0, -7);
  const m = /\.(cbz|zip|cbr|rar|7z)$/i.exec(name);
  if (m) return name.slice(0, -m[0].length);
  return null;
}

/**
 * Split a batch of picked entries into the volumes' own files and the layer
 * files riding beside them. An entry is a layer only when it splits as
 * `<stem>.<id>` AND a sibling in the same directory owns `<stem>` (a
 * `.mokuro`, an archive, or an image folder named `<stem>`) — the same
 * archive-presence rule the cloud listing uses, so `Vol 1.5.mokuro` beside
 * `Vol 1.5.cbz` stays a primary. Standalone layer files (no sibling) are
 * returned in `standalone` for the caller to attach to an installed volume.
 */
export function extractLayerEntries(entries: LayerFileEntry[]): {
  entries: LayerFileEntry[];
  layers: ExtractedLayerEntry[];
  standalone: ExtractedLayerEntry[];
} {
  const stemsByDir = new Map<string, Set<string>>();
  const note = (dir: string, stem: string) => {
    let set = stemsByDir.get(dir);
    if (!set) stemsByDir.set(dir, (set = new Set()));
    set.add(stem.toLowerCase());
  };
  for (const entry of entries) {
    const name = basename(entry.path);
    const dir = dirname(entry.path);
    const stem = sourceStemOf(name);
    // A file that itself reads as `<stem>.<id>.mokuro` is a CANDIDATE layer,
    // never evidence of a volume `<stem>.<id>` — that evidence must come from
    // an archive, an image folder, or a plain `.mokuro`.
    if (stem && !splitLayerSidecarName(name)) note(dir, stem);
    if (stem && !/\.mokuro(\.gz)?$/i.test(name)) note(dir, stem);
    // An image folder named `<stem>` counts as a source of `<stem>`.
    if (dir) note(dirname(dir), basename(dir));
  }

  const kept: LayerFileEntry[] = [];
  const layers: ExtractedLayerEntry[] = [];
  const standalone: ExtractedLayerEntry[] = [];
  for (const entry of entries) {
    const name = basename(entry.path);
    const split = splitLayerSidecarName(name);
    if (!split) {
      kept.push(entry);
      continue;
    }
    const dir = dirname(entry.path);
    const siblings = stemsByDir.get(dir);
    const fullBase = sourceStemOf(name)!.toLowerCase();
    const extracted: ExtractedLayerEntry = { ...entry, ...split, dir };
    if (siblings?.has(fullBase)) {
      // `<stem>.<id>` is itself a volume here (`Vol 1.5.cbz` beside `Vol 1.5.mokuro`).
      kept.push(entry);
    } else if (siblings?.has(split.stem.toLowerCase())) {
      layers.push(extracted);
    } else {
      standalone.push(extracted);
    }
  }
  return { entries: kept, layers, standalone };
}

export interface ReadLayerFile {
  pages: Page[];
  volumeUuid?: string;
  seriesTitle?: string;
  volumeTitle?: string;
}

function isPageArray(value: unknown): value is Page[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) => p && typeof p === 'object' && Array.isArray((p as Page).blocks) && 'img_width' in p
    )
  );
}

/** Parse a layer file (gz tolerated) into DB-shaped pages plus the ids it names. */
export async function readLayerFile(file: File | Blob, gz = false): Promise<ReadLayerFile | null> {
  try {
    let blob: Blob = file;
    if (gz) {
      if (typeof DecompressionStream === 'undefined') return null;
      blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
    }
    const json = JSON.parse(await blob.text()) as Record<string, unknown>;
    if (!isPageArray(json.pages)) return null;
    return {
      pages: json.pages.map((p) => {
        const { cumulativeChars: _c, ...page } = p as Page & { cumulativeChars?: number };
        return page;
      }),
      ...(typeof json.volume_uuid === 'string' ? { volumeUuid: json.volume_uuid } : {}),
      ...(typeof json.title === 'string' ? { seriesTitle: json.title } : {}),
      ...(typeof json.volume === 'string' ? { volumeTitle: json.volume } : {})
    };
  } catch {
    return null;
  }
}

/** Write (or overwrite) one layer of a volume from imported pages. No cloud stamp: the next listing pushes it. */
export async function attachLayerToVolume(
  volumeUuid: string,
  layerId: string,
  pages: Page[]
): Promise<VolumeOcrLayer> {
  const now = new Date().toISOString();
  return db.transaction('rw', db.volume_ocr_layers, async () => {
    const existing = await db.volume_ocr_layers.get([volumeUuid, layerId]);
    const kind = existing?.kind ?? layerKindForId(layerId);
    const layer: VolumeOcrLayer = {
      volume_uuid: volumeUuid,
      layer_id: layerId,
      name: existing?.name ?? layerNameForId(layerId),
      kind,
      ...(existing?.engine
        ? { engine: existing.engine }
        : kind === 'ocr'
          ? { engine: layerId }
          : {}),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      pages
    };
    await db.volume_ocr_layers.put(layer);
    return layer;
  });
}

/**
 * The local row a layer file belongs to: the `volume_uuid` inside the file
 * when a row has it, else a title match (`<stem>` against `volume_title`,
 * the hint or the file's own `title` against `series_title`; with neither
 * series hint, any series holding exactly one volume of that title).
 */
export async function resolveLayerTarget(
  stem: string,
  read: ReadLayerFile,
  hint?: { seriesTitle?: string }
): Promise<VolumeMetadata | null> {
  if (read.volumeUuid) {
    const byUuid = await db.volumes.get(read.volumeUuid);
    if (byUuid && !byUuid.isPlaceholder) return byUuid;
  }
  const titleKey = normalizeVolumeTitleKey(stem);
  const seriesTitle = hint?.seriesTitle ?? read.seriesTitle;
  let candidates: VolumeMetadata[];
  if (seriesTitle) {
    candidates = await volumesForFoldedSeriesTitle(seriesTitle, normalizeSeriesKey);
  } else {
    candidates = await db.volumes.toArray();
  }
  const matches = candidates.filter(
    (v) => !v.isPlaceholder && normalizeVolumeTitleKey(v.volume_title) === titleKey
  );
  return matches.length === 1 ? matches[0] : null;
}

export type AttachLayerFileResult =
  | { status: 'attached'; volumeUuid: string; layerId: string; volumeTitle: string }
  | { status: 'no-match'; stem: string; layerId: string }
  | { status: 'invalid' };

/** Attach one standalone `<stem>.<id>.mokuro[.gz]` file to the volume it names. */
export async function attachLayerFile(
  file: File,
  hint?: { seriesTitle?: string; path?: string }
): Promise<AttachLayerFileResult> {
  const split = splitLayerSidecarName(basename(hint?.path ?? file.name));
  if (!split) return { status: 'invalid' };
  const read = await readLayerFile(file, split.gz);
  if (!read) return { status: 'invalid' };
  const target = await resolveLayerTarget(split.stem, read, hint);
  if (!target) return { status: 'no-match', stem: split.stem, layerId: split.layerId };
  await attachLayerToVolume(target.volume_uuid, split.layerId, read.pages);
  return {
    status: 'attached',
    volumeUuid: target.volume_uuid,
    layerId: split.layerId,
    volumeTitle: target.volume_title
  };
}

// ---- layers riding a batch import: applied once their volume is saved ----

const pending: ExtractedLayerEntry[] = [];

export function stashLayerEntries(entries: ExtractedLayerEntry[]): void {
  pending.push(...entries);
}

export function clearStashedLayerEntries(): void {
  pending.length = 0;
}

/** Attach every stashed layer whose stem matches the volume just saved. Never throws. */
export async function applyStashedLayersFor(
  volumeUuid: string,
  volumeTitle: string
): Promise<number> {
  const key = normalizeVolumeTitleKey(volumeTitle);
  let applied = 0;
  for (let i = pending.length - 1; i >= 0; i--) {
    const entry = pending[i];
    if (normalizeVolumeTitleKey(entry.stem) !== key) continue;
    pending.splice(i, 1);
    try {
      const read = await readLayerFile(entry.file, entry.gz);
      if (!read) continue;
      await attachLayerToVolume(volumeUuid, entry.layerId, read.pages);
      applied++;
    } catch (error) {
      console.warn(`[layer-import] could not attach '${entry.path}':`, error);
    }
  }
  return applied;
}
