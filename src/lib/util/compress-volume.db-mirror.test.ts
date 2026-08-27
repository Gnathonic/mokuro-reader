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
 * The mechanical half of the same guard. The behavioural test above proves the
 * mirror does not WIPE a table, but it cannot see a table whose primary key or
 * indexes drifted — the two connections would simply file rows under different
 * key paths, and the damage shows up later as reads that find nothing. So:
 * compare the two independently-written version ladders directly.
 *
 * Vite reads the sources as text at transform time — no node:fs, so this runs
 * the same way under vitest as it would in any browser-target runner.
 */
const SOURCES = import.meta.glob('/src/lib/{catalog/db-v3,util/compress-volume}.ts', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

function schemaLadder(path: string): string[] {
  const source = SOURCES[path];
  if (source === undefined) throw new Error(`no source text for ${path}`);
  return [...source.matchAll(/\.version\((\d+)\)\.stores\(\{([\s\S]*?)\}\)/g)].map(
    ([, version, body]) => `v${version} {${body.replace(/\s+/g, ' ').trim()}}`
  );
}

describe('compress-volume worker DB schema mirror', () => {
  const main = schemaLadder('/src/lib/catalog/db-v3.ts');
  const mirror = schemaLadder('/src/lib/util/compress-volume.ts');

  it('finds both version ladders (guards against a broken scanner)', () => {
    // Without this a regex that matched nothing would make [] === [] pass.
    expect(main).toHaveLength(2);
    expect(mirror).toHaveLength(2);
    expect(main.join('\n')).toContain('catalog_index');
  });

  it('declares exactly the same version ladder as db-v3.ts', () => {
    expect(mirror).toEqual(main);
  });
});
