import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlFileResult, ProviderStatus } from '$lib/util/sync/provider-interface';
import {
  cloudBunkoHolder,
  cloudBunkoStatus,
  compareMarkerRank,
  ingestMarkerRead,
  isMarkerFresh,
  markerRecords,
  onCloudBunkoMarkerChange,
  parseBunkoMarker,
  resetCloudBunkoMarkersForTest,
  withCloudBunkoStatus,
  clearCloudBunkoMarkers,
  type MarkerNodeRecord
} from './cloud-bunko-marker';
import { editExisting } from '$lib/interop/contract';
import { servedMarker } from './__fixtures__/bunko-marker';

const T0 = Date.parse('2026-10-12T10:00:00Z');
const TTL = 900;

/** Bunko's own marker (its contract fixture), with these tests' values in its fields. */
function marker(over: Record<string, unknown> = {}) {
  return editExisting(servedMarker(T0), {
    instance_id: 'aaa',
    boot_id: 'b1',
    instance_name: 'nas',
    bunko_version: '0.8.0',
    epoch: 3,
    claimed_at: '2026-10-12T09:00:00Z',
    heartbeat_at: new Date(T0).toISOString(),
    ttl_s: TTL,
    ...over
  });
}

function read(
  ...nodes: Array<{ id: string; etag: string; body: unknown }>
): Exclude<ControlFileResult, 'not-modified' | null> {
  return {
    etag: nodes.map((n) => `${n.id}=${n.etag}`).join('|'),
    nodes: nodes.map((n) => ({
      id: n.id,
      etag: n.etag,
      blob: new Blob([typeof n.body === 'string' ? n.body : JSON.stringify(n.body)])
    }))
  };
}

function rec(over: Partial<MarkerNodeRecord> = {}): MarkerNodeRecord {
  return {
    id: 'n1',
    version: 'v1',
    instance_id: 'aaa',
    instance_name: 'nas',
    heartbeat_at: new Date(T0).toISOString(),
    ttl_s: TTL,
    state: 'active',
    epoch: 1,
    claimed_at: '2026-10-12T09:00:00Z',
    compiles: ['series.json', 'catalog.json'],
    changedAt: T0,
    ...over
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  localStorage.clear();
  resetCloudBunkoMarkersForTest();
});

afterEach(() => {
  resetCloudBunkoMarkersForTest();
  vi.useRealTimers();
});

describe('parseBunkoMarker', () => {
  it('reads the §9.2 shape and ignores unknown fields', () => {
    const m = parseBunkoMarker({ ...marker(), future_field: 1 });
    expect(m).toMatchObject({
      instance_id: 'aaa',
      instance_name: 'nas',
      epoch: 3,
      ttl_s: TTL,
      state: 'active',
      compiles: ['series.json', 'catalog.json'],
      ocr: true
    });
  });

  it('refuses what is not a marker', () => {
    expect(parseBunkoMarker(null)).toBeNull();
    expect(parseBunkoMarker({ ...marker(), version: 2 })).toBeNull();
    expect(parseBunkoMarker({ ...marker(), kind: 'other' })).toBeNull();
    expect(parseBunkoMarker({ ...marker(), instance_id: '' })).toBeNull();
  });

  it('defaults a missing ttl to 900 s', () => {
    expect(parseBunkoMarker({ ...marker(), ttl_s: undefined })?.ttl_s).toBe(900);
  });
});

describe('freshness rules', () => {
  it('fresh while now − changedAt < 2 × ttl, and only for files it compiles', () => {
    const r = rec();
    expect(isMarkerFresh(r, T0 + 2 * TTL * 1000 - 1)).toBe(true);
    expect(isMarkerFresh(r, T0 + 2 * TTL * 1000)).toBe(false);
    expect(isMarkerFresh(r, T0, 'series.json')).toBe(true);
    expect(isMarkerFresh(rec({ compiles: ['catalog.json'] }), T0, 'series.json')).toBe(false);
  });

  it('released is honoured at once', () => {
    expect(isMarkerFresh(rec({ state: 'released' }), T0)).toBe(false);
    expect(isMarkerFresh(rec({ state: 'weird' }), T0)).toBe(false);
  });

  it('cold start: fresh while |now − heartbeat_at| < ttl + 5 min (skew both ways)', () => {
    const cold = (beatOffsetS: number) =>
      rec({ changedAt: null, heartbeat_at: new Date(T0 + beatOffsetS * 1000).toISOString() });
    expect(isMarkerFresh(cold(-(TTL + 299)), T0)).toBe(true);
    expect(isMarkerFresh(cold(-(TTL + 300)), T0)).toBe(false);
    // Bunko's clock ahead of ours: allowed within the same bound.
    expect(isMarkerFresh(cold(TTL + 299), T0)).toBe(true);
    expect(isMarkerFresh(cold(TTL + 300), T0)).toBe(false);
    expect(isMarkerFresh(rec({ changedAt: null, heartbeat_at: 'garbage' }), T0)).toBe(false);
  });

  it('a skewed heartbeat does not matter once the node has history', () => {
    const r = rec({ heartbeat_at: '2020-01-01T00:00:00Z', changedAt: T0 });
    expect(isMarkerFresh(r, T0 + 60_000)).toBe(true);
  });

  it('ranks epoch desc, claimed_at asc, instance_id asc', () => {
    const a = rec({ id: 'a', epoch: 2, instance_id: 'zzz' });
    const b = rec({ id: 'b', epoch: 3, instance_id: 'yyy', claimed_at: '2026-10-12T09:30:00Z' });
    const c = rec({ id: 'c', epoch: 3, instance_id: 'xxx', claimed_at: '2026-10-12T09:30:00Z' });
    const d = rec({ id: 'd', epoch: 3, instance_id: 'www', claimed_at: '2026-10-12T09:40:00Z' });
    expect([a, b, c, d].sort(compareMarkerRank).map((r) => r.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('the marker store', () => {
  it('an unchanged marker polled every 30 s goes stale after 2 × ttl', async () => {
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker() }));
    // First sight: cold, judged by the heartbeat.
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
    // The marker moves once (a heartbeat) — from now on, changedAt rules.
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v2', body: marker() }));
    const seenAt = Date.now();
    let elapsed = 0;
    while (elapsed < 2 * TTL * 1000 - 30_000) {
      vi.advanceTimersByTime(30_000);
      elapsed += 30_000;
      await ingestMarkerRead('google-drive', 'not-modified');
      expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
    }
    vi.setSystemTime(seenAt + 2 * TTL * 1000);
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v2', body: marker() }));
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(false);
    expect(cloudBunkoHolder('google-drive')).toBeNull();
  });

  it('a heartbeat (new version) keeps it fresh', async () => {
    await ingestMarkerRead('onedrive', read({ id: 'n1', etag: 'v1', body: marker() }));
    for (let i = 2; i < 10; i++) {
      vi.advanceTimersByTime((TTL / 3) * 1000);
      await ingestMarkerRead('onedrive', read({ id: 'n1', etag: `v${i}`, body: marker() }));
      expect(cloudBunkoStatus('onedrive')?.fresh).toBe(true);
    }
  });

  it('MEGA: a heartbeat rewritten as a NEW node of the same instance counts as a change', async () => {
    await ingestMarkerRead('mega', read({ id: 'h1', etag: 'h1', body: marker() }));
    await ingestMarkerRead('mega', read({ id: 'h2', etag: 'h2', body: marker() }));
    expect(markerRecords('mega')[0].changedAt).toBe(T0);
  });

  it('released flips the verdict at once and tells listeners', async () => {
    const changed = vi.fn();
    onCloudBunkoMarkerChange(changed);
    await ingestMarkerRead('webdav', read({ id: 'n1', etag: 'v1', body: marker() }));
    expect(changed).toHaveBeenCalledTimes(1);
    await ingestMarkerRead('webdav', read({ id: 'n1', etag: 'v1', body: marker() }));
    expect(changed).toHaveBeenCalledTimes(1); // same verdict: no news
    await ingestMarkerRead(
      'webdav',
      read({ id: 'n1', etag: 'v2', body: marker({ state: 'released' }) })
    );
    expect(cloudBunkoStatus('webdav')?.fresh).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('announces expiry on a timer, without another read', async () => {
    const changed = vi.fn();
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker() }));
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v2', body: marker() }));
    onCloudBunkoMarkerChange(changed);
    vi.advanceTimersByTime(2 * TTL * 1000 - 1000);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(false);
  });

  it('duplicate markers: the holder is the top-ranked fresh one', async () => {
    await ingestMarkerRead(
      'google-drive',
      read(
        { id: 'old', etag: '1', body: marker({ instance_id: 'bbb', epoch: 2 }) },
        { id: 'new', etag: '1', body: marker({ instance_id: 'ccc', epoch: 4 }) },
        { id: 'gone', etag: '1', body: marker({ instance_id: 'ddd', epoch: 9, state: 'released' }) }
      )
    );
    expect(cloudBunkoHolder('google-drive')?.instance_id).toBe('ccc');
    expect(cloudBunkoStatus('google-drive')?.holder?.instanceId).toBe('ccc');
  });

  it('a node that is not JSON says nothing; no node forgets the scope', async () => {
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: '{"version":' }));
    expect(markerRecords('google-drive')).toEqual([]);
    expect(cloudBunkoStatus('google-drive')).toBeUndefined();
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker() }));
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
    await ingestMarkerRead('google-drive', null);
    expect(cloudBunkoStatus('google-drive')).toBeUndefined();
  });

  it('persists history: a reopened app keeps an unchanged marker stale', async () => {
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker() }));
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v2', body: marker() }));
    // Hours later, a new session (module state gone, localStorage kept).
    resetCloudBunkoMarkersForTest();
    vi.setSystemTime(T0 + 5 * 3600_000);
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(false);
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v2', body: marker() }));
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(false);
    // Bunko is alive after all: its marker moved.
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v3', body: marker() }));
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
  });

  it('withCloudBunkoStatus: serverCompilesMetadata = reported || anyMarkerFresh', async () => {
    const base: ProviderStatus = {
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: 'ok'
    };
    expect(withCloudBunkoStatus('mega', base)).toBe(base);
    await ingestMarkerRead('mega', read({ id: 'n1', etag: 'v1', body: marker() }));
    expect(withCloudBunkoStatus('mega', base).serverCompilesMetadata).toBe(true);
    expect(withCloudBunkoStatus('mega', base).cloudBunko?.holder?.instanceName).toBe('nas');
    await ingestMarkerRead('mega', read({ id: 'n1', etag: 'v2', body: marker({ compiles: [] }) }));
    expect(withCloudBunkoStatus('mega', base).serverCompilesMetadata).toBe(false);
    expect(
      withCloudBunkoStatus('mega', { ...base, serverCompilesMetadata: true }).serverCompilesMetadata
    ).toBe(true);
    clearCloudBunkoMarkers('mega');
    expect(withCloudBunkoStatus('mega', base).cloudBunko).toBeUndefined();
  });
});
