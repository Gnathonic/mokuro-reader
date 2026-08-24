import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { thumbnailCache } from './thumbnail-cache';

/**
 * Decodes are held open so the queue can be inspected mid-flight. Within the cache's
 * own warm-up window every decode runs on the main thread through `createImageBitmap`,
 * which is what this replaces.
 */
let releaseDecode: Array<(bitmap: unknown) => void> = [];

function bitmap() {
  return { width: 10, height: 10, close: () => {} };
}

function file(name: string) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/webp' });
}

beforeEach(() => {
  releaseDecode = [];
  (globalThis as unknown as Record<string, unknown>).createImageBitmap = vi.fn(
    () => new Promise((resolve) => releaseDecode.push(resolve))
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('thumbnailCache commit notification', () => {
  it('tells subscribers which volume just landed in the cache', async () => {
    const seen: string[] = [];
    const unsubscribe = thumbnailCache.subscribeCommits((uuid) => seen.push(uuid));

    const load = thumbnailCache.get('commit-1', file('commit-1.webp'));
    expect(seen).toEqual([]);

    releaseDecode[0]?.(bitmap());
    await load;

    expect(seen).toEqual(['commit-1']);

    unsubscribe();
    const second = thumbnailCache.get('commit-2', file('commit-2.webp'));
    releaseDecode[1]?.(bitmap());
    await second;
    expect(seen).toEqual(['commit-1']);
  });
});

describe('thumbnailCache.invalidate', () => {
  it('settles the queued loads it drops instead of orphaning them', async () => {
    // Fill every concurrency slot with decodes that never answer, so the next request
    // is still sitting in the queue when it is invalidated.
    const blockers: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      blockers.push(thumbnailCache.get(`blocker-${i}`, file(`blocker-${i}.webp`)).catch(() => {}));
    }

    const queued = thumbnailCache.get('queued-uuid', file('queued.webp'));
    let settled = false;
    const outcome = queued.then(
      () => {
        settled = true;
        return 'resolved';
      },
      () => {
        settled = true;
        return 'rejected';
      }
    );

    thumbnailCache.invalidate('queued-uuid');

    // A dropped item whose promise never settles leaves every caller's "already
    // loading" guard stuck on that uuid for the life of the component.
    await expect(outcome).resolves.toBe('rejected');
    expect(settled).toBe(true);

    // Drain: releasing a decode dispatches the next queued one, which registers a new
    // resolver, so keep going until nothing new appears.
    for (let pass = 0; pass < 20 && releaseDecode.length > 0; pass++) {
      const pending = releaseDecode;
      releaseDecode = [];
      for (const release of pending) release(bitmap());
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(blockers);
  });
});
