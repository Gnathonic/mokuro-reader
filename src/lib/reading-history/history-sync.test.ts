import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryDexie } from './history-db';
import { appendEvent, getOrCreateDeviceId } from './record';
import { encodeSegment } from './segment-codec';
import { historySegmentPath, historyDeviceFilePath, historyLegacyFilePath } from './paths';
import { syncHistory } from './history-sync';
import type { CloudFileMetadata, SyncProvider } from '$lib/util/sync/provider-interface';
import type { ReadingEvent } from './types';

const OCT = Date.UTC(2026, 9, 3);
const NOV = Date.UTC(2026, 10, 2);

function fakeCloud(status: { serverCompilesMetadata?: boolean; isReadOnly?: boolean } = {}) {
  const files = new Map<string, { bytes: Uint8Array; mtime: string }>();
  let clock = 0;
  const provider = {
    type: 'webdav',
    getStatus: () => ({
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: '',
      ...status
    }),
    uploadFile: vi.fn(async (path: string, blob: Blob | Uint8Array) => {
      files.set(path, {
        bytes:
          blob instanceof Blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(blob),
        mtime: new Date(++clock * 1000).toISOString()
      });
      return { fileId: path };
    }),
    downloadFile: vi.fn(
      async (f: CloudFileMetadata) => new Blob([new Uint8Array(files.get(f.path)!.bytes)])
    )
  } as unknown as SyncProvider;
  const listing = (): CloudFileMetadata[] =>
    [...files].map(([path, f]) => ({
      provider: 'webdav',
      fileId: path,
      path,
      modifiedTime: f.mtime,
      size: f.bytes.length
    }));
  return { provider, files, listing };
}

const page = (volume: string, first: number) => ({
  kind: 'page' as const,
  volume,
  first_page: first,
  last_page: first,
  page_chars: [10],
  chars_before: first * 10,
  dwell_ms: 5000,
  layout: 'single' as const,
  orientation: 'portrait' as const,
  viewport: { w: 400, h: 800 }
});

let a: HistoryDexie;
let b: HistoryDexie;
beforeEach(() => {
  a = new HistoryDexie(`a-${Math.random()}`);
  b = new HistoryDexie(`b-${Math.random()}`);
});

describe('syncHistory', () => {
  it("uploads own months and imports the other device's, in both directions", async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await appendEvent(a, page('v1', 2), NOV);
    await appendEvent(b, page('v2', 7), NOV);
    const devA = await getOrCreateDeviceId(a);

    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect([...cloud.files.keys()].sort()).toEqual([
      historySegmentPath(devA, '2026-10'),
      historySegmentPath(devA, '2026-11')
    ]);
    const r = await syncHistory(cloud.provider, cloud.listing(), b, { force: true, now: NOV });
    expect(r.imported).toBe(2);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });

    const key = (e: ReadingEvent) => `${e.device}:${e.seq}`;
    expect((await a.reading_events.toArray()).map(key).sort()).toEqual(
      (await b.reading_events.toArray()).map(key).sort()
    );
    expect(await a.reading_events.count()).toBe(3);
  });

  it('is idempotent: a second pass downloads and uploads nothing', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    await syncHistory(cloud.provider, cloud.listing(), b, { force: true, now: NOV });
    vi.mocked(cloud.provider.uploadFile).mockClear();
    vi.mocked(cloud.provider.downloadFile).mockClear();
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    const r = await syncHistory(cloud.provider, cloud.listing(), b, { force: true, now: NOV });
    expect(cloud.provider.uploadFile).not.toHaveBeenCalled();
    expect(cloud.provider.downloadFile).not.toHaveBeenCalled();
    expect(r.imported).toBe(0);
  });

  it('the same file listed twice imports once', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    const listed = cloud.listing();
    await syncHistory(cloud.provider, [...listed, { ...listed[0], fileId: 'dup' }], b, {
      now: NOV
    });
    expect(await b.reading_events.count()).toBe(1);
  });

  it('a corrupt file imports nothing and is retried once it is fixed', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    const devA = await getOrCreateDeviceId(a);
    const path = historySegmentPath(devA, '2026-10');
    cloud.files.set(path, {
      bytes: new Uint8Array([9, 9, 9]),
      mtime: 'Mon, 05 Oct 2026 00:00:00 GMT'
    });
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(await b.reading_events.count()).toBe(0);
    expect(await b.history_files.get(path)).toBeUndefined();
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(await b.reading_events.count()).toBe(1);
  });

  it('refuses a file whose events belong to another device than its folder', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    const events = await a.reading_events.toArray();
    const devA = events[0].device;
    cloud.files.set(historySegmentPath('impostor', '2026-10'), {
      bytes: await encodeSegment(devA, '2026-10', events),
      mtime: 'Mon, 05 Oct 2026 00:00:00 GMT'
    });
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(await b.reading_events.count()).toBe(0);
  });

  it('never re-uploads imported events: each device writes only its own folder', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await appendEvent(b, page('v2', 1), OCT);
    const devA = await getOrCreateDeviceId(a);
    const devB = await getOrCreateDeviceId(b);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    await syncHistory(cloud.provider, cloud.listing(), b, { force: true, now: NOV });
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });

    expect([...cloud.files.keys()].sort()).toEqual(
      [historySegmentPath(devA, '2026-10'), historySegmentPath(devB, '2026-10')].sort()
    );
    const { decodeSegment } = await import('./segment-codec');
    const bFile = await decodeSegment(cloud.files.get(historySegmentPath(devB, '2026-10'))!.bytes);
    expect(bFile.events.every((e) => e.device === devB)).toBe(true);
  });

  it('throttles the current month unless forced; closed months always go up', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), NOV);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    await appendEvent(a, page('v1', 2), NOV + 1000);
    vi.mocked(cloud.provider.uploadFile).mockClear();
    await syncHistory(cloud.provider, cloud.listing(), a, { now: NOV + 60_000 });
    expect(cloud.provider.uploadFile).not.toHaveBeenCalled();
    await syncHistory(cloud.provider, cloud.listing(), a, { now: NOV + 6 * 60_000 });
    expect(cloud.provider.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('a failed month upload is retried next time and does not block the others', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await appendEvent(a, page('v1', 2), NOV);
    vi.mocked(cloud.provider.uploadFile).mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    const r = await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(r.failed).toHaveLength(1);
    expect(r.uploaded).toHaveLength(1);
    const r2 = await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(r2.uploaded).toEqual(r.failed);
  });

  it('uploads everything again to a new provider', async () => {
    const first = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(first.provider, first.listing(), a, { force: true, now: NOV });
    const second = fakeCloud();
    (second.provider as { type: string }).type = 'mega';
    const r = await syncHistory(second.provider, second.listing(), a, { force: true, now: NOV });
    expect(r.uploaded).toHaveLength(1);
  });

  it.each([{ serverCompilesMetadata: true }, { isReadOnly: true }])(
    'never uploads on %o, still imports',
    async (status) => {
      const shared = fakeCloud();
      await appendEvent(a, page('v1', 1), OCT);
      await syncHistory(shared.provider, shared.listing(), a, { force: true, now: NOV });
      const limited = {
        ...shared,
        provider: {
          ...shared.provider,
          getStatus: () => ({ ...shared.provider.getStatus(), ...status }),
          uploadFile: vi.fn()
        } as unknown as SyncProvider
      };
      await appendEvent(b, page('v2', 1), OCT);
      await syncHistory(limited.provider, shared.listing(), b, { force: true, now: NOV });
      expect(limited.provider.uploadFile).not.toHaveBeenCalled();
      expect(await b.reading_events.count()).toBe(2);
    }
  );

  it("uploads device facts once, and imports the other device's", async () => {
    const cloud = fakeCloud();
    const devA = await getOrCreateDeviceId(a);
    await a.devices.put({
      device: devA,
      class: 'phone',
      os: 'Android',
      first_seen: 'x',
      last_seen: 'y'
    });
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(cloud.files.has(historyDeviceFilePath(devA))).toBe(true);
    await a.devices.update(devA, { last_seen: 'z' });
    vi.mocked(cloud.provider.uploadFile).mockClear();
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(cloud.provider.uploadFile).not.toHaveBeenCalled();
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect((await b.devices.get(devA))?.class).toBe('phone');
  });

  it('uploads a Blob, through the no-refetch upload when the provider has one', async () => {
    const cloud = fakeCloud();
    const blind = vi.fn(async (path: string, blob: Blob) => {
      cloud.files.set(path, {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mtime: 'Mon, 05 Oct 2026 00:00:00 GMT'
      });
      return { fileId: path };
    });
    (cloud.provider as unknown as { blindUploadFile: typeof blind }).blindUploadFile = blind;
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(cloud.provider.uploadFile).not.toHaveBeenCalled();
    expect(blind).toHaveBeenCalledTimes(1);
    expect(blind.mock.calls[0][1]).toBeInstanceOf(Blob);
    vi.mocked(cloud.provider.uploadFile).mockClear();
    const plain = fakeCloud();
    await syncHistory(plain.provider, plain.listing(), a, { force: true, now: NOV });
    expect(vi.mocked(plain.provider.uploadFile).mock.calls[0][1]).toBeInstanceOf(Blob);
  });

  it('does not stamp a download whose size disagrees with the listing (a stale cached copy)', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    const listed = cloud.listing().map((f) => ({ ...f, size: f.size + 1 }));
    await syncHistory(cloud.provider, listed, b, { now: NOV });
    expect(await b.history_files.count()).toBe(0);
  });

  it('an upload that succeeded is marked even if recording it in the cache throws', async () => {
    const cloud = fakeCloud();
    await appendEvent(a, page('v1', 1), OCT);
    const r = await syncHistory(cloud.provider, cloud.listing(), a, {
      force: true,
      now: NOV,
      onUploaded: () => {
        throw new Error('cache busy');
      }
    });
    expect(r.failed).toEqual([]);
    vi.mocked(cloud.provider.uploadFile).mockClear();
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(cloud.provider.uploadFile).not.toHaveBeenCalled();
  });

  it('never tries to upload a month it cannot name', async () => {
    const cloud = fakeCloud();
    const devA = await getOrCreateDeviceId(a);
    await a.reading_events.add({ ...page('v1', 1), device: devA, seq: 1, t: 1e17 } as ReadingEvent);
    const r = await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    expect(r).toEqual({ imported: 0, uploaded: [], failed: [] });
  });

  it('ignores a device file with an unknown class', async () => {
    const cloud = fakeCloud();
    cloud.files.set(historyDeviceFilePath('dev-x'), {
      bytes: new TextEncoder().encode(
        JSON.stringify({ device: 'dev-x', class: 'toaster', first_seen: 'a', last_seen: 'b' })
      ),
      mtime: 'Mon, 05 Oct 2026 00:00:00 GMT'
    });
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(await b.devices.get('dev-x')).toBeUndefined();
  });

  it("imports another device's legacy segment, and refuses one at a month path", async () => {
    const cloud = fakeCloud();
    const legacy: ReadingEvent[] = [
      { device: 'legacy:vol-1', seq: 1000, t: 1000, kind: 'restart', volume: 'vol-1' },
      { device: 'legacy:vol-2', seq: 2000, t: 2000, kind: 'restart', volume: 'vol-2' }
    ];
    const bytes = await encodeSegment('dev-x', 'legacy', legacy, { legacy: true });
    cloud.files.set(historyLegacyFilePath('dev-x'), {
      bytes,
      mtime: 'Mon, 05 Oct 2026 00:00:00 GMT'
    });
    cloud.files.set(historySegmentPath('dev-y', '1970-01'), {
      bytes,
      mtime: 'Mon, 05 Oct 2026 00:00:00 GMT'
    });
    const r = await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(r.imported).toBe(2);
    expect((await b.reading_events.toArray()).map((e) => e.device).sort()).toEqual([
      'legacy:vol-1',
      'legacy:vol-2'
    ]);
    expect(await b.history_files.get(historySegmentPath('dev-y', '1970-01'))).toBeUndefined();
  });

  it("imported events reach the projected turns without a reload", async () => {
    const { _resetHistoryTurns, getHistoryTurns, loadHistoryTurns } = await import('./turns-store');
    const cloud = fakeCloud();
    await appendEvent(a, page('v-import', 3), OCT);
    await syncHistory(cloud.provider, cloud.listing(), a, { force: true, now: NOV });
    // Loaded from B only now: A's own append (same process) must not count.
    _resetHistoryTurns();
    await loadHistoryTurns(b);
    expect(getHistoryTurns('v-import')).toBeUndefined();
    await syncHistory(cloud.provider, cloud.listing(), b, { now: NOV });
    expect(getHistoryTurns('v-import')).toEqual([[OCT, 3, 40]]);
    _resetHistoryTurns();
  });
});
