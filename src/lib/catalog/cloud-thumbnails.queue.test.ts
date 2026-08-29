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
 * `downloadFile` is a hand-rolled deferred per call, so a test can hold
 * every slot saturated, enqueue waiters, then release slots one at a time and
 * read the GRANT ORDER off the order downloads start. Everything is derived
 * from `MAX_CONCURRENT_FETCHES` so the suite tracks the real cap — the cap's
 * VALUE is pinned separately below.
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

import { fetchCloudThumbnail, MAX_CONCURRENT_FETCHES } from './cloud-thumbnails';

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

/** Every slot's id, S1..Sn — the saturating requests. */
const SATURATORS = Array.from({ length: MAX_CONCURRENT_FETCHES }, (_, i) => `S${i + 1}`);

/** Saturate every download slot; returns their fetch promises. */
async function saturate(): Promise<Array<Promise<unknown>>> {
  const held = SATURATORS.map((id) => fetchCloudThumbnail(vol(id)));
  await flush();
  expect(cloud.calls).toEqual(SATURATORS);
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
    expect(cloud.calls).toHaveLength(MAX_CONCURRENT_FETCHES);

    cloud.resolvers.shift()!(); // S1 finishes, one slot frees
    await flush();
    expect(cloud.calls[MAX_CONCURRENT_FETCHES]).toBe('C'); // newest first...

    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[MAX_CONCURRENT_FETCHES + 1]).toBe('B');

    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[MAX_CONCURRENT_FETCHES + 2]).toBe('A'); // ...oldest last

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
    expect(cloud.calls).toHaveLength(MAX_CONCURRENT_FETCHES);

    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[MAX_CONCURRENT_FETCHES]).toBe('NEAR');

    // The backlog still drains: nothing visible is left, newest-anyway.
    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[MAX_CONCURRENT_FETCHES + 1]).toBe('GONE');

    await drainAll([...held, ...pending]);
  });

  it('probes are consulted at GRANT time, so scrolling back re-prioritizes a waiting request', async () => {
    const held = await saturate();

    // Four waiters, oldest to newest: OLD, MID, NEWER, NEWEST. At every grant
    // below the winner is NOT the newest waiter and at least one other
    // (not-near) waiter remains queued afterward — so elimination alone can
    // never produce the expected order. Only the visibility scan, re-read at
    // grant time, can: a mutant that drops the scan and just pops newest-first
    // would pick NEWEST, then NEWEST-of-what's-left, at every step.
    let oldNear = false;
    const pending = [
      fetchCloudThumbnail(vol('OLD'), () => oldNear),
      fetchCloudThumbnail(vol('MID'), () => true),
      fetchCloudThumbnail(vol('NEWER'), () => false),
      fetchCloudThumbnail(vol('NEWEST'), () => false)
    ];
    await flush();

    // First grant: MID is near but is neither the newest waiter (NEWER and
    // NEWEST both outrank it by recency) nor the last one left (OLD, NEWER
    // and NEWEST are all still queued after it). Only the scan can pick it.
    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[MAX_CONCURRENT_FETCHES]).toBe('MID');

    // The user scrolls back to OLD. NEWER and NEWEST are still queued and
    // still newer than OLD, and neither is near — so OLD winning is not a
    // last-one-standing default. The SAME queued OLD request is preferred
    // only because its probe is re-read live at this grant, not cached from
    // when it was enqueued.
    oldNear = true;
    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[MAX_CONCURRENT_FETCHES + 1]).toBe('OLD');

    // Nothing visible is left: the backlog drains newest-first, same as the
    // no-visibility-preference case — a sanity check that the two remaining
    // requests still resolve.
    cloud.resolvers.shift()!();
    await flush();
    expect(cloud.calls[MAX_CONCURRENT_FETCHES + 2]).toBe('NEWEST');

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
    expect(cloud.calls[MAX_CONCURRENT_FETCHES]).toBe('NEW'); // drain newest-first, visibility or not

    const throwing = fetchCloudThumbnail(vol('THROWS'), () => {
      throw new Error('probe exploded');
    });
    await flush();
    cloud.resolvers.shift()!();
    await flush();
    // A broken probe must not wedge or demote its request forever.
    expect(cloud.calls[MAX_CONCURRENT_FETCHES + 1]).toBe('THROWS');

    await drainAll([...held, ...pending, throwing]);
  });
});

describe('the concurrency bound itself', () => {
  it('is 8 — the widened parallelism the user ruled for, not the old pacing 4', () => {
    // The VALUE is pinned, not just honored: covers are ~32KB and
    // latency-bound, the visible-first stack (not a narrow slot count) is
    // what keeps on-screen cards first, and the user's ruling is that
    // downloads are backgrounded, never paced. 8 fills a screenful twice as
    // fast as the old 4 while staying close enough to the HTTP/1.1 per-host
    // connection pool (6) that grant ordering stays in this queue's hands
    // rather than the browser's FIFO. Lowering this back to 4 is a design
    // decision, and this pin is where it must be made deliberately.
    expect(MAX_CONCURRENT_FETCHES).toBe(8);
  });

  it('starts exactly MAX_CONCURRENT_FETCHES downloads for a wider burst — no more, and eventually all', async () => {
    const EXTRA = 5;
    const burst = Array.from({ length: MAX_CONCURRENT_FETCHES + EXTRA }, (_, i) =>
      fetchCloudThumbnail(vol(`B${i}`))
    );
    await flush();

    // The cap is honored at its widened value: every slot is filled...
    expect(cloud.calls).toHaveLength(MAX_CONCURRENT_FETCHES);
    // ...and not one request beyond it has started.
    expect(cloud.downloadFile).toHaveBeenCalledTimes(MAX_CONCURRENT_FETCHES);

    // Positive control that the cap (and not the burst size) was the limiter,
    // and that nothing beyond it is lost: draining serves every waiter.
    await drainAll(burst);
    expect(cloud.calls).toHaveLength(MAX_CONCURRENT_FETCHES + EXTRA);
  });
});
