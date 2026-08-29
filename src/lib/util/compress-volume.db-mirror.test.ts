/**
 * Regression test for the worker-side Dexie mirror in `getDatabase()`
 * (compress-volume.ts). That function opens a SEPARATE connection to the
 * same `mokuro_v3` database `CatalogDexieV3` (db-v3.ts) owns, with its own
 * independently-declared version ladder — nothing enforces the two schemas
 * staying in sync mechanically.
 *
 * The failure mode this guards against (reproduced while fixing Task 2,
 * fix-round-1): if the mirror's declared version/table set falls behind
 * db-v3.ts's, Dexie's schema-diff auto-heal recreates any table the mirror
 * doesn't declare — silently wiping whatever rows were in it. This test
 * seeds `catalog_index` and `cloud_covers` through the real `CatalogDexieV3`
 * schema, drives a real worker code path (which opens the mirror internally
 * via the unexported `getDatabase()`), and asserts both tables — and their
 * rows — are still there afterward.
 */
import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { CatalogDexieV3 } from '$lib/catalog/db-v3';
import { generateVolumeSidecarsFromDb } from './compress-volume';

afterEach(async () => {
  await Dexie.delete('mokuro_v3');
});

describe('compress-volume worker DB mirror', () => {
  it('does not wipe catalog_index/cloud_covers when the worker opens after the main schema', async () => {
    // Seed through the real, current main schema — this is the source of
    // truth the mirror must stay compatible with.
    const main = new CatalogDexieV3();
    await main.open();
    await main.volumes.add({
      volume_uuid: 'v1',
      series_uuid: 's1',
      series_title: 'Title',
      volume_title: 'Vol 1',
      mokuro_version: '',
      page_count: 1,
      character_count: 1,
      page_char_counts: [1]
    } as never);
    await main.catalog_index.add({ id: 'catalog' } as never);
    await main.cloud_covers.add({
      account_scope: 'mega:a@b.com',
      path: 'Title/Vol 1.cbz',
      thumbnail: new File([new Uint8Array([1, 2, 3])], 'c.webp', { type: 'image/webp' }),
      width: 1,
      height: 1,
      cached_at: 1
    });
    main.close();

    // Drives the real worker-side getDatabase() connection — the code path
    // that must not regress the sibling tables it doesn't itself touch.
    await generateVolumeSidecarsFromDb('v1');

    const reopened = new CatalogDexieV3();
    await reopened.open();
    expect(await reopened.catalog_index.count()).toBe(1);
    expect(await reopened.cloud_covers.count()).toBe(1);
    reopened.close();
  });
});

/**
 * The mechanical half of the same guard.
 *
 * The behavioural test above proves the worker connection does not WIPE a
 * table, but it cannot see a table whose PRIMARY KEY or index list drifted at
 * the SAME version number: neither connection complains, they simply file rows
 * under different key paths, and the damage surfaces later as reads that find
 * nothing. That divergence used to be possible because the ladder was written
 * out twice; it is not any more, because `db-schema.ts` states it once and both
 * connections apply it (`declareMokuroSchema`).
 *
 * So these two tests guard the only remaining ways back in:
 *
 * 1. a hand-written `.version(n).stores({...})` ladder reappearing next to
 *    either connection — which is what would re-create two sources of truth;
 * 2. the shared declaration itself changing a primary key or an index list,
 *    which is a database migration rather than an edit, and must not happen by
 *    accident. Asserted against a signature spelled out here independently, so
 *    editing the schema alone cannot make its own test agree with it.
 *
 * Vite reads the sources as text at transform time — no node:fs, so this runs
 * the same way under vitest as it would in any browser-target runner.
 */
const SOURCES = import.meta.glob(
  '/src/lib/{catalog/db-v3,catalog/migration/migrate,util/compress-volume}.ts',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

/** A literal `.version(<number>).stores(` — the thing that must appear once, in db-schema.ts. */
const LITERAL_LADDER = /\.version\(\s*\d+\s*\)\s*\.stores\(/;

function source(path: string): string {
  const text = SOURCES[path];
  if (text === undefined) throw new Error(`no source text for ${path}`);
  return text;
}

const MOKURO_DB_CONNECTIONS = ['/src/lib/catalog/db-v3.ts', '/src/lib/util/compress-volume.ts'];

describe('mokuro_v3 has exactly one schema declaration', () => {
  it('matches a real hand-written ladder (guards against a broken scanner)', () => {
    // Positive control: `migrate.ts` legitimately declares literal ladders for
    // the LEGACY `mokuro` database. Without this, a glob that silently returned
    // nothing — or a regex that matched nothing — would make both assertions
    // below pass vacuously.
    const legacy = source('/src/lib/catalog/migration/migrate.ts');
    expect(legacy).toMatch(LITERAL_LADDER);
    expect([...legacy.matchAll(new RegExp(LITERAL_LADDER, 'g'))]).toHaveLength(2);
  });

  it.each(MOKURO_DB_CONNECTIONS)('%s declares no ladder of its own', (path) => {
    expect(source(path)).not.toMatch(LITERAL_LADDER);
  });

  it.each(MOKURO_DB_CONNECTIONS)('%s takes the shared declaration', (path) => {
    expect(source(path)).toContain('declareMokuroSchema(');
  });
});

/**
 * The live schema Dexie derives from the shared declaration, as
 * `store: <primary key> [<indexes>]`. Read off the opened connection rather
 * than off `MOKURO_DB_SCHEMA`, so a typo Dexie parses differently than it reads
 * still shows up here.
 */
function schemaSignature(db: Dexie): string[] {
  return db.tables
    .map((table) => {
      const indexes = table.schema.indexes.map((index) => index.src).sort();
      return `${table.name}: ${table.schema.primKey.src} [${indexes.join(', ')}]`;
    })
    .sort();
}

describe('the shared mokuro_v3 schema', () => {
  it('has exactly these stores, primary keys and indexes', async () => {
    const db = new CatalogDexieV3('mokuro_v3_schema_signature_test');
    await db.open();
    try {
      expect(schemaSignature(db)).toEqual([
        'catalog_index: id []',
        'cloud_covers: [account_scope+path] [cached_at]',
        'series_index: series_key []',
        'series_metadata: series_key [folded_key]',
        'volume_files: volume_uuid []',
        'volume_ocr: volume_uuid []',
        'volumes: volume_uuid [series_title, series_uuid]'
      ]);
    } finally {
      db.close();
      await Dexie.delete('mokuro_v3_schema_signature_test');
    }
  });
});
