/**
 * The main-thread API over a volume's OCR LAYERS — the alternate page sets that
 * sit beside a volume's PRIMARY OCR row. A layer is stored as a small metadata
 * row plus a pages row (`$lib/catalog/layer-store.ts` — the only code that
 * touches the two tables, and the reason a metadata question never costs a
 * page read). The primary row (`volume_ocr`) stays
 * what every existing consumer reads (stats, exports, backups, bunko); a
 * layer is only ever shown by the reader (when the volume's `ocrLayer`
 * setting names it), edited in place, exported as its own `.mokuro`, or
 * PROMOTED into the primary row. `original` is the pre-edit snapshot the
 * editor keeps for "revert page" and is read-only here.
 *
 * Cloud sync of layers (`<Volume Title>.<id>.mokuro` beside the
 * archive) lives in a later PR; nothing here touches a provider.
 */
import { db } from '$lib/catalog/db';
import {
  deleteLayerRows,
  getLayerMeta,
  getLayerPages,
  getLayerWithPages,
  layerTables,
  listLayerIds,
  listLayerMetas,
  putLayerWithPages,
  updateLayerMeta
} from '$lib/catalog/layer-store';
import { buildPageCharCounts } from '$lib/catalog/cloud-ocr-upgrade';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { buildLayerMokuroMetadata } from '$lib/util/mokuro-metadata';
import { LAYER_ID_RE, layerSidecarName } from '$lib/util/sync/syncable-file';
import type { Page, VolumeOcrLayer, VolumeOcrLayerKind, VolumeOcrLayerWithPages } from '$lib/types';
import {
  EDIT_LAYER_ID,
  isCuratedLayerId,
  isPersonalLayerId,
  isReservedLayerId,
  isServerKeepsakeLayerId,
  layerNameForId,
  titleCasedLayerId
} from './layer-names';
import { ORIGINAL_LAYER_ID, noteLayerEdited } from './edit-persist';
import { editLayerEpoch } from './edit-layer-epoch';
import {
  TRANSLATION_PROMOTE_BLOCKED,
  isTranslationLayer,
  isTranslationLayerId
} from './layer-kind';

// Pure names live apart, so a view can name a layer without this module's graph.
export { layerNameForId, titleCasedLayerId };

export const LAYER_KIND_LABEL: Record<VolumeOcrLayerKind, string> = {
  original: 'Original',
  edit: 'Edit',
  ocr: 'OCR',
  translation: 'Translation'
};

const MAX_SLUG = 24;

/**
 * Engine ids whose files are OCR output (bunko engines + the reader's own).
 * A FALLBACK only: a server names its generations itself (`hayai-nova-ctd`,
 * `my-best`), so what a layer file IS gets read from the file (`servedEngineOf`).
 * This list files the ones that carry no stamp — stock mokuro output, and rows
 * that arrived before the stamp was read.
 */
export const KNOWN_ENGINE_IDS: ReadonlySet<string> = new Set([
  'gcv',
  'hayai',
  'hayai-nova',
  'paddle-manga',
  'ppocr-manga',
  'mokuro-fp16',
  'mokuro'
]);

const SERVED_ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The engine that produced a layer file, when a SERVER produced it. bunko
 * stamps every layer sidecar it generates with a top-level
 * `ocr_engine: { id, … }`, and no LAYER file this app writes carries one (a
 * pushed edit layer carries `edited`; only a primary carries a block, and only
 * one it installed — `ocr-provenance.ts`). So the stamp, not the file's name,
 * tells a server's OCR from a person's edits: the name is whatever the
 * server's admin called that generation, and no closed list of ids can know it.
 */
export function servedEngineOf(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const meta = (json as { ocr_engine?: unknown }).ocr_engine;
  if (!meta || typeof meta !== 'object') return undefined;
  const id = (meta as { id?: unknown }).id;
  return typeof id === 'string' && SERVED_ENGINE_ID_RE.test(id) ? id : undefined;
}

/**
 * A layer of corrections by its id alone: the shared `curated`, an account's
 * `edit`/`edit-<n>`, or bunko's keepsake (a case merge's `curated-<n>`). No
 * server stamp makes one of them a generation (`layerKindForId`,
 * `layer-sync`'s re-filing).
 */
export function isCorrectionsLayerId(layerId: string): boolean {
  return (
    isCuratedLayerId(layerId) || isPersonalLayerId(layerId) || isServerKeepsakeLayerId(layerId)
  );
}

/**
 * The kind a layer file with no local row is filed under: from the engine
 * stamp it carried (`servedEngineOf`) when it had one, else from its id alone.
 */
export function layerKindForId(layerId: string, servedEngine?: string): VolumeOcrLayerKind {
  if (layerId === ORIGINAL_LAYER_ID) return 'original';
  if (isTranslationLayerId(layerId)) return 'translation';
  // Corrections whatever the file claims: the shared `curated` layer, an
  // account's own `edit`, a case merge's `curated-<n>`. What may write them is
  // read from the id (`layerStaysLocal`).
  if (isCorrectionsLayerId(layerId)) return 'edit';
  if (servedEngine || KNOWN_ENGINE_IDS.has(layerId)) return 'ocr';
  return 'edit';
}

/**
 * A display name → a unique `layer_id` slug. Never a reserved id or family
 * (`isReservedLayerId`) and always with a letter in it (sidecar names rule v1
 * #8): such a slug becomes `layer-<slug>` — a `-<n>` alone would never
 * leave `edit-<n>`, `curated-<n>` or `tr-…` — then de-duplicates.
 */
export function slugifyLayerId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const prefixed = (slug: string) => `layer-${slug}`.slice(0, MAX_SLUG).replace(/-+$/g, '');
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  if (!base) base = 'layer';
  // An all-digit id is valid in a listing, but bunko's listing-free paths
  // need a letter to tell `Vol 1.2024.mokuro` from the primary of `Vol 1.2024`.
  if (!/[a-z]/.test(base) || isReservedLayerId(base)) base = prefixed(base);
  let candidate = base;
  let n = 2;
  while (used.has(candidate) || !LAYER_ID_RE.test(candidate) || isReservedLayerId(candidate)) {
    candidate = `${base.slice(0, MAX_SLUG - 3)}-${n++}`;
    // `tr` is free but `tr-2` is a translation id: step out the same way.
    if (isReservedLayerId(candidate)) {
      base = prefixed(base);
      candidate = base;
      n = 2;
    }
  }
  return candidate;
}

function assertEditable(layerId: string): void {
  if (layerId === ORIGINAL_LAYER_ID) throw new Error('The original layer is read-only');
}

/**
 * May this layer's PAGES be written here? Never the `original` snapshot, and
 * never the shared `curated` layer: only Publish writes that (`layer-sync`),
 * and an in-place edit would be pulled over by the next listing anyway. Its
 * name stays the user's to change: a display name is local.
 */
function assertPagesWritable(layerId: string): void {
  assertEditable(layerId);
  if (isCuratedLayerId(layerId)) throw new Error('The shared corrections layer is read-only');
}

function byOriginalThenCreated(a: VolumeOcrLayer, b: VolumeOcrLayer): number {
  if (a.layer_id === ORIGINAL_LAYER_ID) return -1;
  if (b.layer_id === ORIGINAL_LAYER_ID) return 1;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/** A volume's layers, Original first then oldest first — metadata only, no pages. */
export async function listLayers(volumeUuid: string): Promise<VolumeOcrLayer[]> {
  return (await listLayerMetas(db, volumeUuid)).sort(byOriginalThenCreated);
}

export function loadLayerPages(volumeUuid: string, layerId: string): Promise<Page[] | null> {
  return getLayerPages(db, volumeUuid, layerId);
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

/** A source page with its image facts and no text. */
function blankPage(source: Page): Page {
  return { ...source, blocks: [] };
}

export async function createLayer(
  volumeUuid: string,
  opts: CreateLayerOptions
): Promise<VolumeOcrLayerWithPages> {
  const now = new Date().toISOString();
  return db.transaction('rw', layerTables(db), async () => {
    const taken = await listLayerIds(db, volumeUuid);
    const source = opts.pages === 'empty' ? (opts.sourcePages ?? []) : opts.pages;
    const pages: Page[] = opts.pages === 'empty' ? source.map(blankPage) : structuredClone(source);
    const layer: VolumeOcrLayerWithPages = {
      volume_uuid: volumeUuid,
      layer_id: slugifyLayerId(opts.name, taken),
      name: opts.name.trim() || 'Layer',
      kind: opts.kind ?? 'edit',
      ...(opts.engine ? { engine: opts.engine } : {}),
      created_at: now,
      updated_at: now,
      pages
    };
    await putLayerWithPages(db, layer);
    return layer;
  });
}

export async function renameLayer(
  volumeUuid: string,
  layerId: string,
  name: string
): Promise<void> {
  assertEditable(layerId);
  const n = await updateLayerMeta(db, volumeUuid, layerId, { name: name.trim() || 'Layer' });
  if (!n) throw new Error(`Layer ${layerId} not found`);
}

export async function deleteLayer(volumeUuid: string, layerId: string): Promise<void> {
  assertEditable(layerId);
  await deleteLayerRows(db, volumeUuid, layerId);
}

/** The editor's write path when an alternate layer is displayed. */
export async function persistLayerPageEdit(
  volumeUuid: string,
  layerId: string,
  pageIndex: number,
  page: Page
): Promise<void> {
  assertPagesWritable(layerId);
  await db.transaction('rw', layerTables(db), async () => {
    const row = await getLayerWithPages(db, volumeUuid, layerId);
    if (!row) throw new Error(`Layer ${layerId} not found`);
    const pages = row.pages.slice();
    pages[pageIndex] = page;
    await putLayerWithPages(db, { ...row, pages, updated_at: new Date().toISOString() });
  });
  noteLayerEdited();
}

/**
 * An edit of a layer that must stay as it is (`forksOnEdit`) goes into the
 * account's own `edit` layer: made here from `sourceLayerId`'s pages when
 * there is none, with no cloud stamp, so the next sync pushes it wherever
 * personal layers go up (`layerNeedsPush`). An existing `edit` layer holds
 * corrections of its own and is never overwritten (`copyIntoEditLayer` does
 * that, on the user's word) — nor is one only listed in the cloud so far: the
 * caller pulls that first (`pullOwnEditLayerBeforeEdit`, `layer-sync.ts`).
 */
export async function forkIntoEditLayer(
  volumeUuid: string,
  sourceLayerId: string
): Promise<{ created: boolean }> {
  const created = await db.transaction('rw', layerTables(db), async () => {
    if (await getLayerMeta(db, volumeUuid, EDIT_LAYER_ID)) return false;
    const source = await getLayerPages(db, volumeUuid, sourceLayerId);
    if (!source) throw new Error(`Layer ${sourceLayerId} not found`);
    const now = new Date().toISOString();
    await putLayerWithPages(db, {
      volume_uuid: volumeUuid,
      layer_id: EDIT_LAYER_ID,
      name: layerNameForId(EDIT_LAYER_ID),
      kind: 'edit',
      created_at: now,
      updated_at: now,
      pages: structuredClone(source)
    });
    return true;
  });
  return { created };
}

/**
 * "Copy to your corrections": `sourceLayerId`'s pages REPLACE the `edit`
 * layer's (made when there is none). The row keeps its name, creation and
 * cloud stamp, so the replacement is an edit since its last sync and goes up
 * like any other. The caller has the user's confirmation.
 */
export async function copyIntoEditLayer(volumeUuid: string, sourceLayerId: string): Promise<void> {
  await db.transaction('rw', layerTables(db), async () => {
    const source = await getLayerPages(db, volumeUuid, sourceLayerId);
    if (!source) throw new Error(`Layer ${sourceLayerId} not found`);
    const existing = await getLayerMeta(db, volumeUuid, EDIT_LAYER_ID);
    const now = new Date().toISOString();
    await putLayerWithPages(db, {
      ...(existing ?? {
        volume_uuid: volumeUuid,
        layer_id: EDIT_LAYER_ID,
        name: layerNameForId(EDIT_LAYER_ID),
        kind: 'edit' as const,
        created_at: now
      }),
      updated_at: now,
      pages: structuredClone(source)
    });
  });
  noteLayerEdited();
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
 * primary write goes through the same recount + `ocr_edited_at` stamp as an
 * in-place edit. It stays LOCAL: the cloud main `.mokuro` is
 * model output and is never re-uploaded from a promoted primary (D4).
 *
 * A TRANSLATION layer is refused (see `TRANSLATION_PROMOTE_BLOCKED`): that
 * very recount would zero the volume's character stats. The UI never offers
 * it; this is the backstop for every caller that is not the UI.
 */
export async function promoteLayer(
  volumeUuid: string,
  layerId: string
): Promise<{ replacedLayerId: string | null }> {
  editLayerEpoch(); // a promotion after it is never migrated into an `edit` layer
  const now = new Date();
  const editedAt = now.toISOString();
  const result = await db.transaction(
    'rw',
    [db.volumes, db.volume_ocr, ...layerTables(db)],
    async () => {
      const layer = await getLayerWithPages(db, volumeUuid, layerId);
      if (!layer) throw new Error(`Layer ${layerId} not found`);
      if (isTranslationLayer(layer)) throw new Error(TRANSLATION_PROMOTE_BLOCKED);
      const ocr = await db.volume_ocr.get(volumeUuid);
      if (!ocr) throw new Error(`Volume ${volumeUuid} has no OCR row to promote into`);

      // Pages only: whether an original exists is all its metadata could add.
      const originalPages = await getLayerPages(db, volumeUuid, ORIGINAL_LAYER_ID);
      let replaced: string | null = null;
      if (!originalPages) {
        await putLayerWithPages(db, {
          volume_uuid: volumeUuid,
          layer_id: ORIGINAL_LAYER_ID,
          name: 'Original',
          kind: 'original',
          created_at: editedAt,
          updated_at: editedAt,
          pages: ocr.pages
        });
      } else if (!samePages(ocr.pages, originalPages)) {
        replaced = replacedLayerId(now, await listLayerIds(db, volumeUuid));
        await putLayerWithPages(db, {
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
        ocr_edited_at: editedAt,
        // The primary's BASE revision (`mokuro_sha256`): promoting the OCR
        // upgrade's `updated-ocr` layer adopts the cloud file it mirrors, so
        // that file is no longer "new" to this volume. Any other layer is a
        // local change on top of the same base — `ocr_edited_at` says so — and
        // leaves the hash alone. Where the cloud stores the adopted file is not
        // known here, so nothing may vouch for it until the next upload.
        ...(layer.source_sha256
          ? { mokuro_sha256: layer.source_sha256, mokuro_sha256_cloud: undefined }
          : {})
      });
      return { replacedLayerId: replaced };
    }
  );
  // No upload: promotion is a LOCAL view choice (bunko design 0.8 D4). The
  // main sidecar stays model output — a later cloud write of it is built from
  // the `original` snapshot (`mainSidecarPagesForCloud`), never from this.
  return result;
}

/** The layer as its own upstream-format `.mokuro`, named for the cloud convention. */
export async function buildLayerExportFile(volumeUuid: string, layerId: string): Promise<File> {
  const [volume, layer] = await Promise.all([
    db.volumes.get(volumeUuid),
    getLayerWithPages(db, volumeUuid, layerId)
  ]);
  if (!volume) throw new Error(`Volume ${volumeUuid} not found`);
  if (!layer) throw new Error(`Layer ${layerId} not found`);
  const { totalChars } = buildPageCharCounts(layer.pages);
  const meta = buildLayerMokuroMetadata(volume, layer, totalChars);
  return new File([JSON.stringify(meta)], layerSidecarName(volume.volume_title, layerId), {
    type: 'application/json'
  });
}

export interface UpsertLayerPagesOptions {
  name: string;
  kind: VolumeOcrLayerKind;
  engine: string;
  /** The pages whose image facts a NEW layer's untouched pages keep. */
  sourcePages: Page[];
  /** pageIndex → the page to write. */
  pages: Map<number, Page>;
  /**
   * The layer's pages as they stood when the run STARTED (`null`: it had no
   * layer yet). Given, a page is written only while the stored page still
   * equals its run-start self; anything else got there after the run began —
   * a hand edit made mid-run — and is kept instead. Layer rows carry no
   * per-page stamp, and the run's own flushes move the row's `updated_at`, so
   * page content is the only per-page signal there is. Omitted: no guard.
   */
  baseline?: Page[] | null;
}

function samePage(a: Page, b: Page): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Engine results: create the layer on first use, overwrite only the pages that
 * ran — minus any page hand-edited since the run started (`opts.baseline`),
 * which the returned layer still holds as stored, not as given.
 *
 * Resolves `null`, having written nothing, when the volume is no longer
 * installed. A whole-volume run outlives the reader that started it, so its
 * flushes can land after the volume was deleted (`deleteVolumeCompletely`
 * takes the layer rows with it) — an unconditional put would mint an orphan
 * layer row for a volume that no longer exists. The `volumes` read shares the
 * transaction with the put, so a delete cannot slip between the two. The
 * caller treats `null` as "stop the run".
 */
export async function upsertLayerPages(
  volumeUuid: string,
  layerId: string,
  opts: UpsertLayerPagesOptions
): Promise<VolumeOcrLayerWithPages | null> {
  assertPagesWritable(layerId);
  const now = new Date().toISOString();
  return db.transaction('rw', [db.volumes, ...layerTables(db)], async () => {
    const volume = await db.volumes.get(volumeUuid);
    if (!volume || !isVolumeInstalled(volume)) return null;
    const existing = await getLayerWithPages(db, volumeUuid, layerId);
    const base: Page[] = existing ? existing.pages.slice() : opts.sourcePages.map(blankPage);
    // A run writes each page once, so until then the stored page is whatever
    // the run started from — or the blank a layer it created begins with.
    const blank = (i: number): Page => blankPage(opts.sourcePages[i]);
    for (const [i, page] of opts.pages) {
      if (opts.baseline !== undefined) {
        const atStart = opts.baseline?.[i] ?? blank(i);
        if (!samePage(base[i] ?? blank(i), atStart)) continue;
      }
      base[i] = page;
    }
    const layer: VolumeOcrLayerWithPages = {
      volume_uuid: volumeUuid,
      layer_id: layerId,
      name: existing?.name ?? opts.name,
      kind: existing?.kind ?? opts.kind,
      engine: opts.engine,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      pages: base
    };
    await putLayerWithPages(db, layer);
    return layer;
  });
}
