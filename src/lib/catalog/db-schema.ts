import type Dexie from 'dexie';

/**
 * THE schema for the `mokuro_v3` database — declared once, as data, because
 * more than one connection opens it.
 *
 * `CatalogDexieV3` (db-v3.ts) owns it on the main thread, and
 * `compress-volume.ts` opens a SEPARATE connection to the same on-disk database
 * from a Web Worker. Nothing in IndexedDB reconciles two differing declarations
 * of one database, and the two ways they break are not symmetrical:
 *
 * - a connection declaring an OLDER version than what is on disk throws
 *   `VersionError` on open (loud, harmless);
 * - a connection declaring a NEWER version with a SMALLER store set makes
 *   Dexie treat the missing stores as "added since" and recreate them, wiping
 *   every row in them — silent data loss, reproduced once on this branch when a
 *   worker mirror stuck on an old table list emptied `catalog_index` and
 *   `cloud_covers` the moment it opened after the main schema;
 * - and a SAME-version divergence in a primary key or an index list is quieter
 *   still: neither connection complains, they simply file rows under different
 *   key paths, and the damage surfaces later as reads that find nothing.
 *
 * A shared constant removes the whole class: there is one declaration, so there
 * is nothing to diverge. `compress-volume.db-mirror.test.ts` guards the only
 * remaining way back in — someone re-introducing a hand-written
 * `.version(n).stores({...})` ladder next to one of the connections.
 *
 * This module deliberately imports NOTHING at runtime (`import type` is erased),
 * so the Worker can take the schema without dragging in the main-thread graph
 * `db-v3.ts` carries — `$app/environment`, the progress tracker, the thumbnail
 * generator.
 */
export const MOKURO_DB_NAME = 'mokuro_v3';

export interface MokuroSchemaVersion {
  version: number;
  stores: Record<string, string>;
}

export const MOKURO_DB_SCHEMA: readonly MokuroSchemaVersion[] = [
  // v1: the shipped schema — three tables, thumbnails inlined in volumes.
  // This is the only version any released build has written, so it must stay
  // exactly as-is for every existing user database to upgrade from.
  {
    version: 1,
    stores: {
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid'
    }
  },
  // v2: everything the series-metadata work adds, in one step.
  //
  // Collapsed deliberately: `series_metadata`, `series_index` and
  // `catalog_index` were separate versions during development but never
  // shipped, so no database exists at those intermediate versions and the
  // steps between them are fiction. A released client upgrades 1 -> 2 once
  // and gets all four new tables.
  //
  // `catalog_index` holds exactly ONE row, at the fixed key `'catalog'`: the
  // root `catalog.json` is a single document, fetched whole and read whole, so
  // it is cached whole rather than shredded into a row per series.
  //
  // `series_metadata`'s `folded_key` is a DERIVED secondary key —
  // `normalizeVolumeTitleKey(series_title)`, the primary key's fold plus NFC.
  // Names that arrive off a filesystem can be decomposed while the record was
  // keyed off a composed title, so the sites that match a cloud FOLDER against a
  // record cannot use the primary key; without this index each of them answered
  // by reading the whole table and folding every row in JS. `store.ts` is the
  // only writer and stamps it through `toStoredSeriesMetadata` — see
  // `StoredSeriesMetadata` for why that is a type-level guarantee rather than a
  // convention.
  //
  // It is added to version 2 IN PLACE, not as a version 3, for the same reason
  // v2 collapsed the development versions: no released build has ever written a
  // v2 database, so there is nothing to migrate. (A DEVELOPMENT database already
  // sitting at v2 does not get the new index — Dexie only re-indexes when the
  // declared version is higher — so a dev database from before this change must
  // be deleted, exactly as it must for any of the other v2 edits.)
  //
  // `cloud_covers` holds ONLY the thumbnail blob (+ dimensions) for a cloud
  // volume the user has neither installed nor read, keyed by account + path
  // because providers expose no uuid for a file the client has not opened, and
  // the same path under a different account is a different file. Everything
  // else a cloud card needs — title, counts, the cover sidecar's own
  // size/modified stamps — already lives in the cached `series_index` row for
  // that series, so this table carries no other field and needs no secondary
  // index: a read is always "these exact paths for this account."
  {
    version: 2,
    stores: {
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid',
      series_metadata: 'series_key, folded_key',
      series_index: 'series_key',
      catalog_index: 'id',
      cloud_covers: '[account_scope+path], cached_at'
    }
  }
];

/**
 * Declare the full `mokuro_v3` version ladder on `db`.
 *
 * Every connection to this database — main thread, Worker, test fixture — must
 * go through here rather than writing its own `.version(n).stores({...})`, for
 * the reasons on {@link MOKURO_DB_SCHEMA}. Applying it is part of the shared
 * definition too: a second call site that declared the same store sets in a
 * different ORDER, or skipped a version, would drift just as badly as one that
 * changed a key path.
 */
export function declareMokuroSchema(db: Dexie): void {
  for (const { version, stores } of MOKURO_DB_SCHEMA) db.version(version).stores(stores);
}
