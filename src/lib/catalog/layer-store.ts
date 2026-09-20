/**
 * The ONLY code that touches `volume_ocr_layers` and `volume_ocr_layer_pages`.
 *
 * One OCR layer is two rows under the same `[volume_uuid+layer_id]` key: a
 * small METADATA row (name, kind, stamps, cloud sync state) and a PAGES row
 * (every page's OCR — megabytes). IndexedDB always deserializes whole rows, so
 * the split is what keeps "list this volume's layers" and "which layers of
 * this folder changed?" from reading a library's worth of OCR. It only works
 * while two rules hold, which is why they live in one module:
 *
 * - a METADATA operation (`getLayerMeta`, `listLayerMetas…`, `listLayerIds`,
 *   `listVolumeUuidsWithLayers`, `updateLayerMeta`, `patchLayerMeta`) never
 *   opens the pages table — a performance contract, asserted by op-count in
 *   `layer-store.test.ts`, `layer-summaries.test.ts`, `layer-sync.test.ts` and
 *   `edit-persist.test.ts`;
 * - every write of pages goes through `putLayerWithPages`, which writes both
 *   rows in ONE transaction, so `updated_at` on the metadata row always moves
 *   with the pages it describes. Everything that reasons about a layer without
 *   reading it (`passive_at === updated_at`, `updated_at > cloud.synced_at`)
 *   depends on that.
 *
 * Every function takes the connection as its first argument and this module
 * imports nothing at runtime, because the export Worker (`compress-volume.ts`)
 * opens its own connection and cannot load the main-thread `db` graph. On the
 * main thread `$lib/reader/edit/layers.ts` is the layer API; this is the
 * storage underneath it.
 *
 * Called inside a caller's transaction, these join it — so that transaction
 * must list BOTH tables (`layerTables(db)`), or Dexie rejects the call.
 */
import type Dexie from 'dexie';
import type { Table } from 'dexie';
import type {
  Page,
  VolumeOcrLayer,
  VolumeOcrLayerPages,
  VolumeOcrLayerWithPages
} from '$lib/types';

export const LAYER_META_TABLE = 'volume_ocr_layers';
export const LAYER_PAGES_TABLE = 'volume_ocr_layer_pages';

type LayerKey = [volumeUuid: string, layerId: string];

function metaTable(db: Dexie): Table<VolumeOcrLayer, LayerKey> {
  return db.table(LAYER_META_TABLE);
}

function pagesTable(db: Dexie): Table<VolumeOcrLayerPages, LayerKey> {
  return db.table(LAYER_PAGES_TABLE);
}

/** Both layer tables — what a caller's own transaction over layers must list. */
export function layerTables(db: Dexie): Table[] {
  return [metaTable(db), pagesTable(db)];
}

// ---- metadata only: never opens the pages table ----

export function getLayerMeta(
  db: Dexie,
  volumeUuid: string,
  layerId: string
): Promise<VolumeOcrLayer | undefined> {
  return metaTable(db).get([volumeUuid, layerId]);
}

export function listLayerMetas(db: Dexie, volumeUuid: string): Promise<VolumeOcrLayer[]> {
  return metaTable(db).where('volume_uuid').equals(volumeUuid).toArray();
}

/** The metadata rows of MANY volumes in one indexed query (any order). */
export function listLayerMetasForVolumes(
  db: Dexie,
  volumeUuids: string[]
): Promise<VolumeOcrLayer[]> {
  if (volumeUuids.length === 0) return Promise.resolve([]);
  return metaTable(db).where('volume_uuid').anyOf(volumeUuids).toArray();
}

/**
 * The uuid of every volume that has at least one layer — read off the
 * `volume_uuid` index, keys only, so it costs the same whether the layers are
 * empty or hold a library of OCR.
 */
export async function listVolumeUuidsWithLayers(db: Dexie): Promise<Set<string>> {
  const uuids = await metaTable(db).orderBy('volume_uuid').uniqueKeys();
  return new Set(uuids as string[]);
}

/** A volume's layer ids, keys only — not even the metadata rows are read. */
export async function listLayerIds(db: Dexie, volumeUuid: string): Promise<string[]> {
  const keys = await metaTable(db).where('volume_uuid').equals(volumeUuid).primaryKeys();
  return keys.map((key) => key[1]);
}

/**
 * Patch a layer's metadata (a rename, a cloud stamp) without touching — or
 * reading — its pages. Resolves Dexie's update count: 0 when there is no such
 * layer. Deliberately cannot move `updated_at`: that stamp means "the pages
 * changed", and only `putLayerWithPages` changes pages.
 */
export function updateLayerMeta(
  db: Dexie,
  volumeUuid: string,
  layerId: string,
  changes: Partial<Pick<VolumeOcrLayer, 'name' | 'cloud' | 'kind' | 'engine'>>
): Promise<number> {
  return metaTable(db).update([volumeUuid, layerId], changes);
}

/**
 * `updateLayerMeta` where the patch depends on the row as it stands NOW: read,
 * decide and write share one transaction — over the metadata table alone — so
 * a page write (which always moves `updated_at` here too) cannot land between
 * them. `decide` returning undefined, or no such layer, writes nothing.
 */
export function patchLayerMeta(
  db: Dexie,
  volumeUuid: string,
  layerId: string,
  decide: (
    meta: VolumeOcrLayer
  ) => Partial<Pick<VolumeOcrLayer, 'name' | 'cloud' | 'kind' | 'engine'>> | undefined
): Promise<void> {
  return db.transaction('rw', metaTable(db), async () => {
    const meta = await metaTable(db).get([volumeUuid, layerId]);
    const changes = meta && decide(meta);
    if (changes) await metaTable(db).update([volumeUuid, layerId], changes);
  });
}

// ---- pages ----

/** One layer's pages, or null when there is no such layer. */
export async function getLayerPages(
  db: Dexie,
  volumeUuid: string,
  layerId: string
): Promise<Page[] | null> {
  return (await pagesTable(db).get([volumeUuid, layerId]))?.pages ?? null;
}

/**
 * A layer with its pages, read in one transaction so the `updated_at` handed
 * back is the stamp of exactly these pages (an upload snapshot relies on it).
 * A metadata row whose pages row is missing is not a usable layer: undefined.
 */
export function getLayerWithPages(
  db: Dexie,
  volumeUuid: string,
  layerId: string
): Promise<VolumeOcrLayerWithPages | undefined> {
  return db.transaction('r', layerTables(db), async () => {
    const meta = await metaTable(db).get([volumeUuid, layerId]);
    if (!meta) return undefined;
    const row = await pagesTable(db).get([volumeUuid, layerId]);
    return row ? { ...meta, pages: row.pages } : undefined;
  });
}

/** Every layer of a volume with its pages (any order) — for exports and backups. */
export function listLayersWithPages(
  db: Dexie,
  volumeUuid: string
): Promise<VolumeOcrLayerWithPages[]> {
  return db.transaction('r', layerTables(db), async () => {
    const [metas, rows] = await Promise.all([
      metaTable(db).where('volume_uuid').equals(volumeUuid).toArray(),
      pagesTable(db).where('volume_uuid').equals(volumeUuid).toArray()
    ]);
    const pagesById = new Map(rows.map((row) => [row.layer_id, row.pages]));
    return metas.flatMap((meta) => {
      const pages = pagesById.get(meta.layer_id);
      return pages ? [{ ...meta, pages }] : [];
    });
  });
}

/**
 * Write (create or replace) a layer: both rows, one transaction. The caller
 * owns every metadata field, `updated_at` included — this is storage, not
 * policy.
 */
export function putLayerWithPages(db: Dexie, layer: VolumeOcrLayerWithPages): Promise<void> {
  // Callers build `layer` by spreading rows, so `pages` is split off here, at
  // the one choke point, rather than trusted to be absent: a pages array that
  // leaked onto the metadata row would silently undo the split.
  const { pages, ...meta } = layer;
  return db.transaction('rw', layerTables(db), async () => {
    await metaTable(db).put(meta);
    await pagesTable(db).put({ volume_uuid: layer.volume_uuid, layer_id: layer.layer_id, pages });
  });
}

// ---- deletes: always both rows ----

export function deleteLayerRows(db: Dexie, volumeUuid: string, layerId: string): Promise<void> {
  return db.transaction('rw', layerTables(db), async () => {
    await metaTable(db).delete([volumeUuid, layerId]);
    await pagesTable(db).delete([volumeUuid, layerId]);
  });
}

export function deleteLayersOfVolume(db: Dexie, volumeUuid: string): Promise<void> {
  return db.transaction('rw', layerTables(db), async () => {
    await metaTable(db).where('volume_uuid').equals(volumeUuid).delete();
    await pagesTable(db).where('volume_uuid').equals(volumeUuid).delete();
  });
}

export function clearAllLayers(db: Dexie): Promise<void> {
  return db.transaction('rw', layerTables(db), async () => {
    await metaTable(db).clear();
    await pagesTable(db).clear();
  });
}
