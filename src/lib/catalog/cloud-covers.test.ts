import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from './db';
import {
  putCloudCovers,
  _getCloudCoversForTests,
  pruneExpiredCloudCovers,
  CLOUD_COVER_MAX_AGE_MS,
  type CloudCover
} from './cloud-covers';

function cover(over: Partial<CloudCover> = {}): CloudCover {
  return {
    account_scope: 'mega:a@b.com',
    path: 'Dr Stone/Volume 01.cbz',
    thumbnail: new File([new Uint8Array([1, 2, 3])], 'c.webp', { type: 'image/webp' }),
    width: 250,
    height: 350,
    cached_at: 1756000000000,
    ...over
  };
}

beforeEach(async () => {
  await db.cloud_covers.clear();
});

describe('cloud cover CRUD', () => {
  it('round-trips a cover under its composite key', async () => {
    await putCloudCovers([cover()]);
    const rows = await _getCloudCoversForTests('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(rows.size).toBe(1);
    expect(rows.get('Dr Stone/Volume 01.cbz')?.width).toBe(250);
  });

  it('keeps two accounts separate even for the identical path', async () => {
    await putCloudCovers([
      cover({ account_scope: 'mega:a@b.com', width: 111 }),
      cover({ account_scope: 'mega:other@b.com', width: 222 })
    ]);
    const a = await _getCloudCoversForTests('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    const other = await _getCloudCoversForTests('mega:other@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(a.get('Dr Stone/Volume 01.cbz')?.width).toBe(111);
    expect(other.get('Dr Stone/Volume 01.cbz')?.width).toBe(222);
  });

  it('normalizes the path on write so a decomposed listing hits the same row', async () => {
    await putCloudCovers([cover({ path: '//Dr Stone//Volume 01.cbz' })]);
    const rows = await _getCloudCoversForTests('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(rows.size).toBe(1);
  });

  it('reads only the requested paths, keyed by normalized path — never the rest of the table', async () => {
    await putCloudCovers([
      cover({ path: 'Dr Stone/Volume 01.cbz' }),
      cover({ path: 'Naruto/Volume 01.cbz', width: 999 })
    ]);
    const rows = await _getCloudCoversForTests('mega:a@b.com', ['Naruto/Volume 01.cbz']);
    expect(Array.from(rows.keys())).toEqual(['Naruto/Volume 01.cbz']);
    expect(rows.get('Naruto/Volume 01.cbz')?.width).toBe(999);
  });

  it('returns an empty map for an empty path list, without touching the db', async () => {
    const rows = await _getCloudCoversForTests('mega:a@b.com', []);
    expect(rows.size).toBe(0);
  });
});

describe('cloud cover expiry', () => {
  const NOW = 1_800_000_000_000;

  it('is 14 days', () => {
    // Pinned literal, not the same expression the constant is written as: an
    // identical expression on both sides cannot catch an edit that changes both.
    expect(CLOUD_COVER_MAX_AGE_MS).toBe(1_209_600_000);
  });

  it('deletes covers cached longer ago than the max age', async () => {
    await putCloudCovers([
      cover({ path: 'Old/Volume 01.cbz', cached_at: NOW - CLOUD_COVER_MAX_AGE_MS - 1 }),
      cover({ path: 'Fresh/Volume 01.cbz', cached_at: NOW - 1000 })
    ]);

    const deleted = await pruneExpiredCloudCovers(NOW);

    expect(deleted).toBe(1);
    expect((await _getCloudCoversForTests('mega:a@b.com', ['Old/Volume 01.cbz'])).size).toBe(0);
    expect((await _getCloudCoversForTests('mega:a@b.com', ['Fresh/Volume 01.cbz'])).size).toBe(1);
  });

  it('keeps a cover exactly at the boundary', async () => {
    await putCloudCovers([cover({ cached_at: NOW - CLOUD_COVER_MAX_AGE_MS })]);
    expect(await pruneExpiredCloudCovers(NOW)).toBe(0);
  });

  it('prunes across every account, not just the connected one', async () => {
    const stale = NOW - CLOUD_COVER_MAX_AGE_MS - 1;
    await putCloudCovers([
      cover({ account_scope: 'mega:a@b.com', cached_at: stale }),
      cover({ account_scope: 'webdav:h|nathan', cached_at: stale })
    ]);
    expect(await pruneExpiredCloudCovers(NOW)).toBe(2);
  });
});
