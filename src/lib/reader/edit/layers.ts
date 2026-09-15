/**
 * Every read and write of `volume_ocr_layers` — the alternate page sets that
 * sit beside a volume's PRIMARY OCR row. The primary row (`volume_ocr`) stays
 * what every existing consumer reads (stats, exports, backups, bunko); a
 * layer is only ever shown by the reader (when the volume's `ocrLayer`
 * setting names it), edited in place, exported as its own `.mokuro`, or
 * PROMOTED into the primary row. `original` is the pre-edit snapshot the
 * editor keeps for "revert page" and is read-only here.
 *
 * Cloud sync of layers (`<Volume Title>.layer.<id>.mokuro` beside the
 * archive) lives in a later PR; nothing here touches a provider.
 */
import { db } from '$lib/catalog/db';
import { buildPageCharCounts } from '$lib/catalog/cloud-ocr-upgrade';
import { buildMokuroMetadata } from '$lib/util/mokuro-metadata';
import { noteOcrEdited } from '$lib/util/sync/sidecar-backfill';
import { LAYER_ID_RE, layerSidecarName } from '$lib/util/sync/syncable-file';
import type { Page, VolumeOcrLayer, VolumeOcrLayerKind } from '$lib/types';
import { ORIGINAL_LAYER_ID } from './edit-persist';

export const LAYER_KIND_LABEL: Record<VolumeOcrLayerKind, string> = {
  original: 'Original',
  edit: 'Edit',
  ocr: 'OCR',
  translation: 'Translation'
};

const MAX_SLUG = 24;

/** A display name → a unique `layer_id` slug (never the reserved `original`). */
export function slugifyLayerId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  if (!base) base = 'layer';
  let candidate = base;
  let n = 2;
  while (candidate === ORIGINAL_LAYER_ID || used.has(candidate) || !LAYER_ID_RE.test(candidate)) {
    candidate = `${base.slice(0, MAX_SLUG - 3)}-${n++}`;
  }
  return candidate;
}

function assertEditable(layerId: string): void {
  if (layerId === ORIGINAL_LAYER_ID) throw new Error('The original layer is read-only');
}

function byOriginalThenCreated(a: VolumeOcrLayer, b: VolumeOcrLayer): number {
  if (a.layer_id === ORIGINAL_LAYER_ID) return -1;
  if (b.layer_id === ORIGINAL_LAYER_ID) return 1;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

async function takenIds(volumeUuid: string): Promise<string[]> {
  const keys = await db.volume_ocr_layers.where('volume_uuid').equals(volumeUuid).primaryKeys();
  return keys.map((k) => (k as unknown as [string, string])[1]);
}

export async function listLayers(volumeUuid: string): Promise<VolumeOcrLayer[]> {
  const rows = await db.volume_ocr_layers.where('volume_uuid').equals(volumeUuid).toArray();
  return rows.sort(byOriginalThenCreated);
}

export async function loadLayerPages(volumeUuid: string, layerId: string): Promise<Page[] | null> {
  const row = await db.volume_ocr_layers.get([volumeUuid, layerId]);
  return row?.pages ?? null;
}

export interface CreateLayerOptions {
  name: string;
  kind?: VolumeOcrLayerKind;
  engine?: string;
  /** Pages to copy, or 'empty' to keep only each page's image facts. */
  pages: Page[] | 'empty';
  /** The pages whose image facts an 'empty' layer keeps. */
  sourcePages?: Page[];
}

export async function createLayer(
  volumeUuid: string,
  opts: CreateLayerOptions
): Promise<VolumeOcrLayer> {
  const now = new Date().toISOString();
  return db.transaction('rw', db.volume_ocr_layers, async () => {
    const taken = await takenIds(volumeUuid);
    const source = opts.pages === 'empty' ? (opts.sourcePages ?? []) : opts.pages;
    const pages: Page[] =
      opts.pages === 'empty' ? source.map((p) => ({ ...p, blocks: [] })) : structuredClone(source);
    const layer: VolumeOcrLayer = {
      volume_uuid: volumeUuid,
      layer_id: slugifyLayerId(opts.name, taken),
      name: opts.name.trim() || 'Layer',
      kind: opts.kind ?? 'edit',
      ...(opts.engine ? { engine: opts.engine } : {}),
      created_at: now,
      updated_at: now,
      pages
    };
    await db.volume_ocr_layers.add(layer);
    return layer;
  });
}

export async function renameLayer(
  volumeUuid: string,
  layerId: string,
  name: string
): Promise<void> {
  assertEditable(layerId);
  const n = await db.volume_ocr_layers.update([volumeUuid, layerId], {
    name: name.trim() || 'Layer'
  });
  if (!n) throw new Error(`Layer ${layerId} not found`);
}

export async function deleteLayer(volumeUuid: string, layerId: string): Promise<void> {
  assertEditable(layerId);
  await db.volume_ocr_layers.delete([volumeUuid, layerId]);
}

/** The editor's write path when an alternate layer is displayed. */
export async function persistLayerPageEdit(
  volumeUuid: string,
  layerId: string,
  pageIndex: number,
  page: Page
): Promise<void> {
  assertEditable(layerId);
  await db.transaction('rw', db.volume_ocr_layers, async () => {
    const row = await db.volume_ocr_layers.get([volumeUuid, layerId]);
    if (!row) throw new Error(`Layer ${layerId} not found`);
    const pages = row.pages.slice();
    pages[pageIndex] = page;
    await db.volume_ocr_layers.put({ ...row, pages, updated_at: new Date().toISOString() });
  });
}

/** `replaced-YYYYMMDD-HHMM` (UTC), de-duplicated against `taken`. */
export function replacedLayerId(date: Date, taken: Iterable<string> = []): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
  return slugifyLayerId(`replaced-${stamp}`, taken);
}

function samePages(a: Page[], b: Page[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Make a layer THE primary OCR. The previous primary is never lost: it
 * becomes `original` if no original exists yet, or a `replaced-…` layer if
 * it had drifted from the original (byte-equal → nothing to keep). The
 * primary write goes through the same recount + `ocr_edited_at` stamp +
 * `noteOcrEdited` as an in-place edit, so the cloud `.mokuro` re-uploads.
 */
export async function promoteLayer(
  volumeUuid: string,
  layerId: string
): Promise<{ replacedLayerId: string | null }> {
  const now = new Date();
  const editedAt = now.toISOString();
  const result = await db.transaction(
    'rw',
    [db.volumes, db.volume_ocr, db.volume_ocr_layers],
    async () => {
      const layer = await db.volume_ocr_layers.get([volumeUuid, layerId]);
      if (!layer) throw new Error(`Layer ${layerId} not found`);
      const ocr = await db.volume_ocr.get(volumeUuid);
      if (!ocr) throw new Error(`Volume ${volumeUuid} has no OCR row to promote into`);

      const original = await db.volume_ocr_layers.get([volumeUuid, ORIGINAL_LAYER_ID]);
      let replaced: string | null = null;
      if (!original) {
        await db.volume_ocr_layers.add({
          volume_uuid: volumeUuid,
          layer_id: ORIGINAL_LAYER_ID,
          name: 'Original',
          kind: 'original',
          created_at: editedAt,
          updated_at: editedAt,
          pages: ocr.pages
        });
      } else if (!samePages(ocr.pages, original.pages)) {
        replaced = replacedLayerId(now, await takenIds(volumeUuid));
        await db.volume_ocr_layers.add({
          volume_uuid: volumeUuid,
          layer_id: replaced,
          name: `Previous primary (${editedAt.slice(0, 16).replace('T', ' ')})`,
          kind: 'edit',
          created_at: editedAt,
          updated_at: editedAt,
          pages: ocr.pages
        });
      }

      const pages = structuredClone(layer.pages);
      const { totalChars, cumulative } = buildPageCharCounts(pages);
      await db.volume_ocr.put({ volume_uuid: volumeUuid, pages });
      await db.volumes.update(volumeUuid, {
        page_char_counts: cumulative,
        character_count: totalChars,
        ocr_edited_at: editedAt
      });
      return { replacedLayerId: replaced };
    }
  );
  try {
    noteOcrEdited(volumeUuid);
  } catch (error) {
    console.debug('[layers] could not nominate volume for sidecar re-upload:', error);
  }
  return result;
}

/** The layer as its own upstream-format `.mokuro`, named for the cloud convention. */
export async function buildLayerExportFile(volumeUuid: string, layerId: string): Promise<File> {
  const [volume, layer] = await Promise.all([
    db.volumes.get(volumeUuid),
    db.volume_ocr_layers.get([volumeUuid, layerId])
  ]);
  if (!volume) throw new Error(`Volume ${volumeUuid} not found`);
  if (!layer) throw new Error(`Layer ${layerId} not found`);
  const { totalChars } = buildPageCharCounts(layer.pages);
  const meta = buildMokuroMetadata({ ...volume, character_count: totalChars }, layer.pages);
  return new File([JSON.stringify(meta)], layerSidecarName(volume.volume_title, layerId), {
    type: 'application/json'
  });
}
