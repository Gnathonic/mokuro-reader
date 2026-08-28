import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The cover download slot queue (`cloud-thumbnails.ts`): LIFO with a
 * visibility preference.
 *
 * A fast scroll enqueues a request for every card it passes; FIFO served the
 * cards the user left thousands of pixels behind before the ones on screen.
 * The queue now grants newest-first among waiters whose `stillNear` probe
 * answers yes, and drains everything else newest-first when nothing visible
 * waits — order changes, outcomes never do (every request is eventually
 * granted; the suite completing at all is the no-livelock proof).
 *
 * `downloadFile` is a hand-rolled deferred per call, so a test can hold all
 * four slots saturated, enqueue waiters, then release slots one at a time and
 * read the GRANT ORDER off the order downloads start.
 */

const cloud = vi.hoisted(() => {
  const calls: string[] = [];
  const resolvers: Array<() => void> = [];
  const downloadFile = vi.fn((file: { fileId: string }) => {
    calls.push(file.fileId);
    return new Promise<Blob>((resolve) => {
      resolvers.push(() => resolve(new Blob([new Uint8Array([1, 2])], { type: 'image/webp' })));
    });
  });
  return { calls, resolvers, downloadFile };
});

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({ type: 'webdav' }),
    downloadFile: cloud.downloadFile
  }
}));

import { fetchCloudThumbnail } from './cloud-thumbnails';

// jsdom has no createImageBitmap; the fetch path only reads dimensions.
(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
  width: 2,
  height: 3,
  close() {}
});

let seq = 0;

/** A fresh fetchable volume per call — unique uuid so the session cache never dedupes. */
function vol(id: string): VolumeMetadata {
  return {
    volume_uuid: `uuid-${id}-${seq}`,
    series_title: 'Series',
    volume_title: id,
    cloudProvider: 'webdav',
    cloudThumbnailFileId: id,
    cloudThumbnailPath: `Series/${id}.webp`
  } as VolumeMetadata;
}

/** Let a resolved download run its post-download chain (bitmap, cache, release, grant). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Resolve every outstanding download until the queue is fully drained. */
async function drainAll(pending: Array<Promise<unknown>>): Promise<void> {
  while (cloud.resolvers.length > 0) {
    cloud.resolvers.shift()!();
    await flush();
  }
  await Promise.all(pending);
}

/** Saturate all four slots; returns their fetch promises. */
async function saturate(): Promise<Array<Promise<unknown>>> {
  const held = ['S1', 'S2', 'S3', 'S4'].map((id) => fetchCloudThumbnail(vol(id)));
  await flush();
  expect(cloud.calls).toEqual(['S1', 'S2', 'S3', 'S4']);
  return held;
}

beforeEach(() => {
  seq += 1;
  cloud.calls.length = 0;
  cloud.resolvers.length = 0;
  cloud.downloadFile.mockClear();
});

describe('cover download slots are granted newest-first (FILO)', () => {
  it('serves the most recently requested cover first once a slot frees', async () => {
    const held = await saturate();

    const pending = [
      fetchCloudThumbnail(vol('A')),
      fetchCloudThumbnail(vol('B')),
      fetchCloudThumbnail(vol('C'))
    ];
    await flush();
    // Positive control: all three are genuinely waiting, none started.
    expect(cloud.calls).toHaveLength(4);

    cloud.resolvers.shift()!(); // S1 finishes, one slot frees
    await flush();
    expect(cloud.calls[4]).toBe('C'); // newest first...

    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[5]).toBe('B');

    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[6]).toBe('A'); // ...oldest last

    await drainAll([...held, ...pending]);
  });
});

describe('visible requests outrank newer invisible ones', () => {
  it('grants the still-near-viewport waiter over a newer one that scrolled away', async () => {
    const held = await saturate();

    const pending = [
      fetchCloudThumbnail(vol('NEAR'), () => true),
      // Newer, but its surface is no longer near the viewport: plain LIFO
      // would pick this one — the probe must outrank recency.
      fetchCloudThumbnail(vol('GONE'), () => false)
    ];
    await flush();
    expect(cloud.calls).toHaveLength(4);

    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[4]).toBe('NEAR');

    // The backlog still drains: nothing visible is left, newest-anyway.
    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[5]).toBe('GONE');

    await drainAll([...held, ...pending]);
  });

  it('probes are consulted at GRANT time, so scrolling back re-prioritizes a waiting request', async () => {
    const held = await saturate();

    let backNear = false;
    const pending = [
      fetchCloudThumbnail(vol('BACK'), () => backNear),
      fetchCloudThumbnail(vol('AHEAD'), () => true)
    ];
    await flush();

    // First grant: BACK is not near yet — AHEAD (also newest) wins.
    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[4]).toBe('AHEAD');

    // The user scrolls back; the SAME queued request is now preferred.
    backNear = true;
    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[5]).toBe('BACK');

    await drainAll([...held, ...pending]);
  });

  it('never starves: with nothing visible the newest is granted anyway, and a throwing probe counts as visible', async () => {
    const held = await saturate();

    const pending = [
      fetchCloudThumbnail(vol('OLD'), () => false),
      fetchCloudThumbnail(vol('NEW'), () => false)
    ];
    await flush();

    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[4]).toBe('NEW'); // drain newest-first, visibility or not

    const throwing = fetchCloudThumbnail(vol('THROWS'), () => {
      throw new Error('probe exploded');
    });
    await flush();
    cloud.resolvers.shift()!();
    await flush();
    // A broken probe must not wedge or demote its request forever.
    expect(cloud.calls[5]).toBe('THROWS');

    await drainAll([...held, ...pending, throwing]);
  });
});
