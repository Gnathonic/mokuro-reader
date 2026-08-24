import { describe, it, expect, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { CloudThumbnailResult } from './cloud-thumbnails';
import { requestCoverOnce, type CoverFetcher } from './cover-requests';

function cloudVolume(uuid = 'cover-uuid'): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 'series',
    series_title: 'Series',
    volume_title: 'Volume 1',
    page_count: 1,
    isPlaceholder: true,
    cloudProvider: 'webdav',
    cloudThumbnailFileId: 'file-1'
  } as VolumeMetadata;
}

const cover: CloudThumbnailResult = {
  file: new File([new Uint8Array([1])], 'cover.webp', { type: 'image/webp' }),
  width: 250,
  height: 350
};

describe('requestCoverOnce', () => {
  it('retries after a request that produced nothing', async () => {
    // The shape every transient failure funnels into: the provider was not connected
    // yet, the 15s timeout fired, the account is saturated by a bulk download.
    const fetchCover = vi.fn(async () => null).mockResolvedValueOnce(null);
    const ledger = new Set<string>();
    const volume = cloudVolume();
    const commit = vi.fn(() => true);

    await requestCoverOnce(ledger, volume, fetchCover, commit, []);

    expect(commit).not.toHaveBeenCalled();
    // Holding the uuid here is what blanks the cover until the surface remounts.
    expect(ledger.has(volume.volume_uuid)).toBe(false);

    const healthy = vi.fn(async () => cover);
    await requestCoverOnce(ledger, volume, healthy, commit, []);

    expect(commit).toHaveBeenCalledExactlyOnceWith(cover);
    expect(ledger.has(volume.volume_uuid)).toBe(true);
  });

  it('does not ask twice once a cover has landed', async () => {
    const fetchCover = vi.fn(async () => cover);
    const ledger = new Set<string>();
    const volume = cloudVolume();

    await requestCoverOnce(ledger, volume, fetchCover, () => true, []);
    await requestCoverOnce(ledger, volume, fetchCover, () => true, []);
    await requestCoverOnce(ledger, volume, fetchCover, () => true, []);

    expect(fetchCover).toHaveBeenCalledTimes(1);
  });

  it('releases the uuid when the caller discards the answer', async () => {
    const fetchCover = vi.fn(async () => cover);
    const ledger = new Set<string>();
    const volume = cloudVolume();
    // A superseded effect run: the cover arrived, but this run is stale and refuses it.
    const discard = vi.fn(() => false);

    await requestCoverOnce(ledger, volume, fetchCover, discard, []);

    expect(discard).toHaveBeenCalledTimes(1);
    expect(ledger.has(volume.volume_uuid)).toBe(false);

    const commit = vi.fn(() => true);
    await requestCoverOnce(ledger, volume, fetchCover, commit, []);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(ledger.has(volume.volume_uuid)).toBe(true);
  });

  it('releases the uuid when the fetch throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new Set<string>();
    const volume = cloudVolume();

    await requestCoverOnce(
      ledger,
      volume,
      async () => {
        throw new Error('network');
      },
      () => true,
      []
    );

    expect(ledger.has(volume.volume_uuid)).toBe(false);
    vi.restoreAllMocks();
  });

  it('holds the uuid while the request is in flight', async () => {
    const ledger = new Set<string>();
    const volume = cloudVolume();
    let release: (result: CloudThumbnailResult) => void = () => {};
    const fetchCover = vi.fn(
      () => new Promise<CloudThumbnailResult>((resolve) => (release = resolve))
    );

    const first = requestCoverOnce(ledger, volume, fetchCover, () => true, []);
    // A second run of the same effect must not fire a duplicate request.
    await requestCoverOnce(ledger, volume, fetchCover, () => true, []);
    expect(fetchCover).toHaveBeenCalledTimes(1);

    release(cover);
    await first;
    expect(ledger.has(volume.volume_uuid)).toBe(true);
  });
});

describe('requestCoverOnce retry schedule', () => {
  it('asks again on its own before giving the uuid up', async () => {
    // The burst that goes quiet: a provider saturated by a bulk download answers `null`
    // for every cover, and then nothing re-renders the catalog. Without a retry of its
    // own the surface has no one left to ask.
    vi.useFakeTimers();
    try {
      const fetchCover = vi
        .fn<CoverFetcher>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(cover);
      const ledger = new Set<string>();
      const volume = cloudVolume();
      const commit = vi.fn(() => true);

      const done = requestCoverOnce(ledger, volume, fetchCover, commit, [10, 20]);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCover).toHaveBeenCalledTimes(1);
      // Held throughout: a retry cycle in flight must not be duplicated by a re-run.
      expect(ledger.has(volume.volume_uuid)).toBe(true);

      await vi.advanceTimersByTimeAsync(10);
      expect(fetchCover).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(20);
      await done;

      expect(fetchCover).toHaveBeenCalledTimes(3);
      expect(commit).toHaveBeenCalledExactlyOnceWith(cover);
      expect(ledger.has(volume.volume_uuid)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the uuid up once the retries are spent', async () => {
    vi.useFakeTimers();
    try {
      const fetchCover = vi.fn<CoverFetcher>().mockResolvedValue(null);
      const ledger = new Set<string>();
      const volume = cloudVolume();

      const done = requestCoverOnce(ledger, volume, fetchCover, () => true, [10, 20]);
      await vi.advanceTimersByTimeAsync(40);
      await done;

      expect(fetchCover).toHaveBeenCalledTimes(3);
      // Released, so a later re-run of the effect may try once more.
      expect(ledger.has(volume.volume_uuid)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
