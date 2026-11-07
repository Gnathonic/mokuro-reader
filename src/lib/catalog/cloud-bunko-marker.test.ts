import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ControlFileResult,
  ProviderStatus,
  SyncProvider
} from '$lib/util/sync/provider-interface';
import {
  cloudBunkoHolder,
  cloudBunkoMergesDuplicates,
  cloudBunkoStatus,
  compareMarkerRank,
  ingestMarkerRead,
  isMarkerFresh,
  markerRecords,
  onCloudBunkoMarkerChange,
  parseBunkoMarker,
  refreshCloudBunkoMarker,
  resetCloudBunkoMarkersForTest,
  withCloudBunkoStatus,
  clearCloudBunkoMarkers,
  type MarkerNodeRecord
} from './cloud-bunko-marker';
import { EPOCH_MS, editExisting } from '$lib/interop/contract';
import { positionsReadAllowed, positionsWriteAllowed } from '$lib/positions/positions-capability';
import { servedMarker } from './__fixtures__/bunko-marker';

const T0 = Date.parse('2026-10-12T10:00:00Z');
const TTL = 900;

/** The 0.8 marker keys (B2.6 per_user_files, B3.6 curated, B5.7 dedup). */
const V08_KEYS = ['per_user_files', 'curated', 'dedup'];

/**
 * Bunko's own marker (its contract fixture), with these tests' values in its
 * fields. A 0.8 key a test does not set is left OUT, whatever the fixture
 * carries: unset means a 0.7 marker's none-of-them, so a test sees the
 * blessed fixture's `dedup: true` only when it asks for it.
 */
function marker(over: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = editExisting(servedMarker(T0), {
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
  for (const k of V08_KEYS) if (!(k in over)) delete body[k];
  return body;
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
    bunko_version: '0.8.0',
    per_user_files: [],
    curated: false,
    dedup: false,
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

  it('keeps bunko_version, per_user_files, curated and dedup', () => {
    const m = parseBunkoMarker(
      marker({
        per_user_files: ['volume-data.json', 'history/'],
        curated: true,
        dedup: true
      })
    );
    expect(m).toMatchObject({
      bunko_version: '0.8.0',
      per_user_files: ['volume-data.json', 'history/'],
      curated: true,
      dedup: true
    });
  });

  it('a 0.7 marker (no new keys) reads as none of them', () => {
    const body = marker({ bunko_version: undefined });
    for (const k of V08_KEYS) expect(body).not.toHaveProperty(k);
    const m = parseBunkoMarker(body);
    expect(m).toMatchObject({
      bunko_version: '',
      per_user_files: [],
      curated: false,
      dedup: false
    });
  });

  it('garbage in the new keys reads as their defaults', () => {
    const m = parseBunkoMarker(
      marker({ bunko_version: 8, per_user_files: 'history/', curated: 'yes', dedup: 1 })
    );
    expect(m).toMatchObject({
      bunko_version: '',
      per_user_files: [],
      curated: false,
      dedup: false
    });
    // A mixed list is not trusted at all: a gate must never read half a list.
    expect(parseBunkoMarker(marker({ per_user_files: ['history/', 3] }))?.per_user_files).toEqual(
      []
    );
  });

  it('reads every 0.8 key of the marker Bunko blesses', () => {
    // Bunko's `marker-active` (or its snapshot without a checkout), sentinels
    // and all. The list order is not part of the contract (the gates test
    // membership); this is the order Bunko writes (C16).
    const m = parseBunkoMarker(servedMarker(EPOCH_MS));
    expect(m).toEqual({
      version: 1,
      instance_id: '<id-1>',
      instance_name: 'contract-host',
      bunko_version: '0.0.0',
      epoch: 1,
      claimed_at: '2000-01-01T00:00:00.000Z',
      heartbeat_at: '2000-01-01T00:00:00.000Z',
      ttl_s: 900,
      state: 'active',
      compiles: ['series.json', 'catalog.json'],
      ocr: true,
      queue: '.mokuro-queue.json',
      per_user_files: [
        'volume-data.json',
        'profiles.json',
        'goals.json',
        'positions.json',
        'history/'
      ],
      curated: true,
      dedup: true
    });
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

  it('a node that is not JSON says nothing', async () => {
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: '{"version":' }));
    expect(markerRecords('google-drive')).toEqual([]);
    expect(cloudBunkoStatus('google-drive')).toBeUndefined();
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker() }));
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
  });

  it('a half-written marker keeps what was known (read as not-modified)', async () => {
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker() }));
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v2', body: marker() }));
    const before = markerRecords('google-drive');
    expect(before[0].changedAt).toBe(T0);
    vi.setSystemTime(T0 + 60_000);
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v3', body: '{"version":' }));
    // Not forgotten, and not stamped as moved: it still ages from T0.
    expect(markerRecords('google-drive')).toEqual(before);
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
    vi.setSystemTime(T0 + 2 * TTL * 1000);
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(false);
  });

  it('a half-written node beside a readable one keeps its own record', async () => {
    await ingestMarkerRead(
      'google-drive',
      read(
        { id: 'a', etag: '1', body: marker({ instance_id: 'aaa', epoch: 4 }) },
        { id: 'b', etag: '1', body: marker({ instance_id: 'bbb', epoch: 2 }) }
      )
    );
    await ingestMarkerRead(
      'google-drive',
      read(
        { id: 'a', etag: '2', body: '{"version":' },
        { id: 'b', etag: '1', body: marker({ instance_id: 'bbb', epoch: 2 }) }
      )
    );
    expect(markerRecords('google-drive').map((r) => r.id)).toEqual(['b', 'a']);
    expect(cloudBunkoHolder('google-drive')?.instance_id).toBe('aaa');
  });

  it('no marker node keeps the fresh records, unstamped, so they age to stale', async () => {
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker() }));
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v2', body: marker() }));
    vi.setSystemTime(T0 + 60_000);
    // A listing that briefly misses the node (a rewrite in flight, an
    // eventually-consistent listing) must not drop the scope for a poll.
    await ingestMarkerRead('google-drive', null);
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
    expect(markerRecords('google-drive')[0].changedAt).toBe(T0);
    await ingestMarkerRead('google-drive', { etag: '', nodes: [] });
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
    vi.setSystemTime(T0 + 2 * TTL * 1000);
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(false);
    // Once nothing kept is fresh, a further empty read forgets the scope.
    await ingestMarkerRead('google-drive', null);
    expect(cloudBunkoStatus('google-drive')).toBeUndefined();
  });

  it('no marker node drops a released record at once', async () => {
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker() }));
    await ingestMarkerRead(
      'google-drive',
      read({ id: 'n1', etag: 'v2', body: marker({ state: 'released' }) })
    );
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

describe('the holder carries the marker v2 keys', () => {
  it('holder reports bunkoVersion, perUserFiles, dedup and curated of the top fresh marker', async () => {
    await ingestMarkerRead(
      'google-drive',
      read(
        {
          id: 'low',
          etag: '1',
          body: marker({ instance_id: 'bbb', epoch: 2, bunko_version: '0.7.3', dedup: true })
        },
        {
          id: 'top',
          etag: '1',
          body: marker({
            instance_id: 'ccc',
            epoch: 4,
            bunko_version: '0.8.0-beta.1',
            per_user_files: ['positions.json', 'history/'],
            curated: true
          })
        }
      )
    );
    expect(cloudBunkoStatus('google-drive')?.holder).toEqual({
      instanceId: 'ccc',
      instanceName: 'nas',
      heartbeatAt: new Date(T0).toISOString(),
      bunkoVersion: '0.8.0-beta.1',
      perUserFiles: ['positions.json', 'history/'],
      dedup: false,
      curated: true
    });
  });

  it('a record stored by an earlier build (no v2 keys) still loads, as none of them', () => {
    const legacy: Record<string, unknown> = { ...rec({ changedAt: T0 }) };
    delete legacy.bunko_version;
    delete legacy.per_user_files;
    delete legacy.curated;
    delete legacy.dedup;
    localStorage.setItem('cloud-bunko-marker:v1', JSON.stringify({ mega: [legacy] }));
    resetCloudBunkoMarkersForTest();
    expect(markerRecords('mega')).toHaveLength(1);
    expect(cloudBunkoStatus('mega')?.holder).toMatchObject({
      instanceId: 'aaa',
      bunkoVersion: '',
      perUserFiles: [],
      dedup: false,
      curated: false
    });
  });

  it('a stored record with a wrongly typed v2 key is dropped', () => {
    localStorage.setItem(
      'cloud-bunko-marker:v1',
      JSON.stringify({
        mega: [
          { ...rec({ id: 'bad1' }), per_user_files: 'history/' },
          { ...rec({ id: 'bad2' }), dedup: 'yes' },
          { ...rec({ id: 'ok' }) }
        ]
      })
    );
    resetCloudBunkoMarkersForTest();
    expect(markerRecords('mega').map((r) => r.id)).toEqual(['ok']);
  });

  it('the v2 keys survive a reload', async () => {
    await ingestMarkerRead(
      'onedrive',
      read({ id: 'n1', etag: 'v1', body: marker({ per_user_files: ['history/'], dedup: true }) })
    );
    resetCloudBunkoMarkersForTest();
    expect(cloudBunkoHolder('onedrive')).toMatchObject({
      per_user_files: ['history/'],
      dedup: true
    });
  });
});

describe('withCloudBunkoStatus: per-user gates from the holder', () => {
  // Gates are always derived from explicit versions here, never from a
  // contract fixture: those report '0.0.0' (a replay sets its gate itself).
  const ALL = ['goals.json', 'profiles.json', 'volume-data.json', 'positions.json', 'history/'];
  const base: ProviderStatus = {
    isAuthenticated: true,
    hasStoredCredentials: true,
    needsAttention: false,
    statusMessage: 'ok'
  };

  async function holder(over: Record<string, unknown>) {
    await ingestMarkerRead('google-drive', read({ id: 'n1', etag: 'v1', body: marker(over) }));
  }

  it.each([
    ['0.8.0', ALL, true, true],
    ['0.8.0-beta.1', ALL, true, true],
    ['0.9.2', ['history/'], true, false],
    ['0.8.0', ['positions.json'], false, true],
    ['0.8.0', [], false, false],
    ['0.7.8', ALL, true, true],
    ['0.7.7', ALL, false, true],
    ['0.7.3', ALL, false, true],
    // The contract sentinel (README "Sentinels": bunko_version is normalized
    // too) is below 0.7.8: a replayed blessed marker folds history OFF even
    // though it lists history/, so a replay must inject its version (C19).
    ['0.0.0', ALL, false, true],
    ['', ALL, false, true]
  ])(
    'holder %j listing %j: historySync %s, positionsSync %s',
    async (version, files, history, positions) => {
      await holder({ bunko_version: version, per_user_files: files });
      const status = withCloudBunkoStatus('google-drive', base);
      expect(status.historySync).toBe(history);
      expect(status.positionsSync).toBe(positions);
    }
  );

  it('a holder whose marker has no per_user_files (pre-0.8 shape) allows neither', async () => {
    await holder({ bunko_version: '0.8.0' });
    const status = withCloudBunkoStatus('google-drive', base);
    expect(status.historySync).toBe(false);
    expect(status.positionsSync).toBe(false);
    expect(positionsReadAllowed(status)).toBe(false);
  });

  it('only the top-ranked fresh holder counts', async () => {
    await ingestMarkerRead(
      'google-drive',
      read(
        {
          id: 'low',
          etag: '1',
          body: marker({ instance_id: 'bbb', epoch: 2, per_user_files: ALL })
        },
        { id: 'top', etag: '1', body: marker({ instance_id: 'ccc', epoch: 4 }) }
      )
    );
    const status = withCloudBunkoStatus('google-drive', base);
    expect(status.historySync).toBe(false);
    expect(status.positionsSync).toBe(false);
  });

  it('no fresh holder (stale or released): both left undefined, plain storage rules apply', async () => {
    await holder({ per_user_files: ALL });
    await ingestMarkerRead(
      'google-drive',
      read({ id: 'n1', etag: 'v2', body: marker({ per_user_files: ALL }) })
    );
    vi.setSystemTime(T0 + 2 * TTL * 1000);
    const stale = withCloudBunkoStatus('google-drive', base);
    expect(stale.cloudBunko?.holder).toBeNull();
    expect(stale.historySync).toBeUndefined();
    expect(stale.positionsSync).toBeUndefined();
    expect(stale.serverCompilesMetadata).toBe(false);
    expect(positionsWriteAllowed(stale)).toBe(true);

    vi.setSystemTime(T0);
    resetCloudBunkoMarkersForTest();
    localStorage.clear();
    await holder({ per_user_files: ALL, state: 'released' });
    const released = withCloudBunkoStatus('google-drive', base);
    expect(released.historySync).toBeUndefined();
    expect(released.positionsSync).toBeUndefined();
  });

  it("the provider's own verdict wins (a WebDAV bunko server's /me)", async () => {
    await holder({ per_user_files: ALL });
    const off = withCloudBunkoStatus('google-drive', {
      ...base,
      historySync: false,
      positionsSync: false
    });
    expect(off.historySync).toBe(false);
    expect(off.positionsSync).toBe(false);

    resetCloudBunkoMarkersForTest();
    localStorage.clear();
    await holder({ bunko_version: '0.7.3', per_user_files: [] });
    const on = withCloudBunkoStatus('google-drive', {
      ...base,
      historySync: true,
      positionsSync: true
    });
    expect(on.historySync).toBe(true);
    expect(on.positionsSync).toBe(true);
  });

  it('a marker-folded status reads and writes positions.json', async () => {
    await holder({ per_user_files: ALL });
    const status = withCloudBunkoStatus('google-drive', base);
    expect(status.serverCompilesMetadata).toBe(true);
    expect(positionsReadAllowed(status)).toBe(true);
    expect(positionsWriteAllowed(status)).toBe(true);
  });
});

describe('curatedPublish from the holder', () => {
  const base: ProviderStatus = {
    isAuthenticated: true,
    hasStoredCredentials: true,
    needsAttention: false,
    statusMessage: 'ok'
  };

  it('is all while a fresh holder keeps a curated layer (cloud-direct: the folder’s owner)', async () => {
    await ingestMarkerRead('mega', read({ id: 'n1', etag: 'v1', body: marker({ curated: true }) }));
    const status = withCloudBunkoStatus('mega', base);
    expect(status.curatedPublish).toBe('all');
    // Cloud-direct pushes its edit layer like plain storage: no gate set here.
    expect(status.editLayerSync).toBeUndefined();
  });

  it('is left as the provider said when the holder keeps none', async () => {
    await ingestMarkerRead('mega', read({ id: 'n1', etag: 'v1', body: marker() }));
    expect(withCloudBunkoStatus('mega', base).curatedPublish).toBeUndefined();
    expect(withCloudBunkoStatus('mega', { ...base, curatedPublish: 'none' }).curatedPublish).toBe(
      'none'
    );
  });

  it('never overrides a verdict the provider reported itself (a WebDAV bunko server’s /me)', async () => {
    // As historySync and positionsSync: the server that answers this account
    // knows its rights; a marker in the same folder only speaks for its owner.
    await ingestMarkerRead(
      'webdav',
      read({ id: 'n1', etag: 'v1', body: marker({ curated: true }) })
    );
    for (const own of ['none', 'owned', 'all'] as const) {
      expect(withCloudBunkoStatus('webdav', { ...base, curatedPublish: own }).curatedPublish).toBe(
        own
      );
    }
    expect(withCloudBunkoStatus('webdav', base).curatedPublish).toBe('all');
  });

  it('stops once the marker is no longer fresh', async () => {
    await ingestMarkerRead('mega', read({ id: 'n1', etag: 'v1', body: marker({ curated: true }) }));
    expect(withCloudBunkoStatus('mega', base).curatedPublish).toBe('all');
    vi.setSystemTime(T0 + 2 * TTL * 1000 + 1000);
    expect(withCloudBunkoStatus('mega', base).cloudBunko?.fresh).toBe(false);
    expect(withCloudBunkoStatus('mega', base).curatedPublish).toBeUndefined();
  });
});

describe('cloudBunkoMergesDuplicates', () => {
  it('is true only while the fresh top-ranked holder says dedup', async () => {
    expect(cloudBunkoMergesDuplicates('mega')).toBe(false);
    await ingestMarkerRead('mega', read({ id: 'n1', etag: 'v1', body: marker({ dedup: true }) }));
    await ingestMarkerRead('mega', read({ id: 'n1', etag: 'v2', body: marker({ dedup: true }) }));
    expect(cloudBunkoMergesDuplicates('mega')).toBe(true);
    // Stale: the marker has not moved for 2 × ttl.
    vi.setSystemTime(T0 + 2 * TTL * 1000);
    expect(cloudBunkoMergesDuplicates('mega')).toBe(false);
  });

  it('is false once the holder released its lease', async () => {
    await ingestMarkerRead('mega', read({ id: 'n1', etag: 'v1', body: marker({ dedup: true }) }));
    await ingestMarkerRead(
      'mega',
      read({ id: 'n1', etag: 'v2', body: marker({ dedup: true, state: 'released' }) })
    );
    expect(cloudBunkoMergesDuplicates('mega')).toBe(false);
  });

  it('a lower-ranked marker saying dedup does not count', async () => {
    await ingestMarkerRead(
      'mega',
      read(
        { id: 'low', etag: '1', body: marker({ instance_id: 'bbb', epoch: 2, dedup: true }) },
        { id: 'top', etag: '1', body: marker({ instance_id: 'ccc', epoch: 4, dedup: false }) }
      )
    );
    expect(cloudBunkoMergesDuplicates('mega')).toBe(false);
  });
});

describe('refreshCloudBunkoMarker', () => {
  function provider(type: string, files: { current: ControlFileResult }) {
    const readControlFile = vi.fn(async (_name: string, opts?: { ifNoneMatch?: string }) => {
      const current = files.current;
      if (current && current !== 'not-modified' && opts?.ifNoneMatch === current.etag) {
        return 'not-modified' as const;
      }
      return current;
    });
    return { provider: { type, readControlFile } as unknown as SyncProvider, readControlFile };
  }

  it('reads the marker once per change, sharing one etag per scope', async () => {
    const files = { current: read({ id: 'n1', etag: 'v1', body: marker({ dedup: true }) }) };
    const p = provider('mega', files);
    expect(await refreshCloudBunkoMarker(p.provider)).toBe(true);
    expect(p.readControlFile).toHaveBeenLastCalledWith('.mokuro-bunko.json', {
      ifNoneMatch: undefined
    });
    expect(cloudBunkoHolder('mega')?.dedup).toBe(true);
    // Another caller (a second provider object, same scope) asks with the etag.
    const other = provider('mega', files);
    expect(await refreshCloudBunkoMarker(other.provider)).toBe(true);
    expect(other.readControlFile).toHaveBeenLastCalledWith('.mokuro-bunko.json', {
      ifNoneMatch: 'n1=v1'
    });
  });

  it('no marker keeps the fresh records but forgets the etag', async () => {
    const files: { current: ControlFileResult } = {
      current: read({ id: 'n1', etag: 'v1', body: marker() })
    };
    const p = provider('google-drive', files);
    await refreshCloudBunkoMarker(p.provider);
    files.current = null;
    await refreshCloudBunkoMarker(p.provider);
    // Still fresh: one empty read is no proof Bunko stopped (it ages out instead).
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
    files.current = read({ id: 'n1', etag: 'v1', body: marker() });
    await refreshCloudBunkoMarker(p.provider);
    expect(p.readControlFile).toHaveBeenLastCalledWith('.mokuro-bunko.json', {
      ifNoneMatch: undefined
    });
    expect(cloudBunkoStatus('google-drive')?.fresh).toBe(true);
  });

  it('a cleared scope asks again from scratch', async () => {
    const files = { current: read({ id: 'n1', etag: 'v1', body: marker() }) };
    const p = provider('mega', files);
    await refreshCloudBunkoMarker(p.provider);
    clearCloudBunkoMarkers('mega');
    await refreshCloudBunkoMarker(p.provider);
    expect(p.readControlFile).toHaveBeenLastCalledWith('.mokuro-bunko.json', {
      ifNoneMatch: undefined
    });
    expect(cloudBunkoStatus('mega')?.fresh).toBe(true);
  });

  it('swallows a failed read and keeps what was known', async () => {
    const files = { current: read({ id: 'n1', etag: 'v1', body: marker() }) };
    const p = provider('mega', files);
    await refreshCloudBunkoMarker(p.provider);
    p.readControlFile.mockRejectedValueOnce(new Error('offline'));
    expect(await refreshCloudBunkoMarker(p.provider)).toBe(false);
    expect(cloudBunkoStatus('mega')?.fresh).toBe(true);
  });

  /** A read whose node body arrives only when `release` is called. */
  function slowRead(body: unknown) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const result = read({ id: 'n1', etag: 'v1', body });
    const blob = result.nodes[0].blob;
    result.nodes[0].blob = {
      text: async () => {
        await gate;
        return blob.text();
      }
    } as Blob;
    return { result, release };
  }

  it('overlapping callers share one read; neither returns before the marker is recorded', async () => {
    const slow = slowRead(marker({ dedup: true }));
    const files: { current: ControlFileResult } = { current: slow.result };
    const poller = provider('mega', files);
    const dedup = provider('mega', files);
    const first = refreshCloudBunkoMarker(poller.provider);
    await vi.advanceTimersByTimeAsync(0);
    let secondDone = false;
    const second = refreshCloudBunkoMarker(dedup.provider).then((ok) => {
      secondDone = true;
      return ok;
    });
    await vi.advanceTimersByTimeAsync(0);
    // The body is still arriving: the second caller must not be told "not modified" yet.
    expect(secondDone).toBe(false);
    slow.release();
    expect(await second).toBe(true);
    expect(cloudBunkoMergesDuplicates('mega')).toBe(true);
    expect(await first).toBe(true);
    expect(poller.readControlFile.mock.calls.length + dedup.readControlFile.mock.calls.length).toBe(
      1
    );
  });

  it('the etag is kept only once its read is recorded', async () => {
    const slow = slowRead(marker());
    const files: { current: ControlFileResult } = { current: slow.result };
    const p = provider('mega', files);
    const pending = refreshCloudBunkoMarker(p.provider);
    await vi.advanceTimersByTimeAsync(0);
    // Cleared mid-read (logout): the read belongs to the forgotten session.
    clearCloudBunkoMarkers('mega');
    slow.release();
    expect(await pending).toBe(false);
    expect(cloudBunkoStatus('mega')).toBeUndefined();
    // So the next read asks from scratch instead of being answered not-modified.
    files.current = read({ id: 'n1', etag: 'v1', body: marker() });
    expect(await refreshCloudBunkoMarker(p.provider)).toBe(true);
    expect(p.readControlFile).toHaveBeenLastCalledWith('.mokuro-bunko.json', {
      ifNoneMatch: undefined
    });
    expect(cloudBunkoStatus('mega')?.fresh).toBe(true);
  });

  it('a provider that cannot read control files is a no-op', async () => {
    const p = { type: 'filesystem' } as unknown as SyncProvider;
    expect(await refreshCloudBunkoMarker(p)).toBe(false);
    expect(cloudBunkoStatus('filesystem')).toBeUndefined();
  });
});
