/**
 * The series page loop (queue file v2 §8.4) against an injected app: which
 * file it reads, what it trusts, what it publishes, and when it reads again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { ControlFileResult, SyncProvider } from '$lib/util/sync/provider-interface';
import type { MarkerNodeRecord } from './cloud-bunko-marker';
import {
  publishSeriesQueueSlice,
  resetSeriesQueueStoreForTest,
  seriesQueueStore
} from './server-ocr-pending';
import {
  MARKER_REREAD_SPACING_MS,
  MEGA_SAFETY_READ_MS,
  followSeriesQueue,
  resetSeriesQueueLoopForTest,
  seriesQueueFollower,
  type SeriesQueueEnv
} from './series-queue-loop';
import { parseSeriesQueueBlock } from './series-queue';
import { servedSeriesQueue } from './__fixtures__/series-queue';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const S = NOW / 1000;
const SERIES = 'Example Saga';
const KEY = 'example saga';
const FILE = '.mokuro-series-queue.json';

function body(over: Record<string, unknown> = {}) {
  return {
    v: 2,
    instance_id: 'aaa',
    rev: 10,
    at: S,
    clock_at: S,
    series: SERIES,
    rows: [{ kind: 'ocr', id: 'hayai-nova' }],
    vols: { 'Example Saga 01': [[0, 'q', S + 600]] },
    done: {},
    ...over
  };
}

const BLOCK = {
  v: 2,
  batch_s: 120,
  held: null,
  held_rows: [],
  clock: [
    [S, S],
    [S + 86_400, S + 86_400]
  ],
  clock_at: S
};

function holder(over: Partial<MarkerNodeRecord> = {}, block: unknown = BLOCK): MarkerNodeRecord {
  return {
    id: 'm',
    version: '1',
    instance_id: 'aaa',
    instance_name: 'nas',
    heartbeat_at: '',
    ttl_s: 900,
    state: 'active',
    epoch: 1,
    claimed_at: '',
    compiles: ['series.json'],
    bunko_version: '0.8.0',
    per_user_files: [],
    curated: false,
    dedup: false,
    series_queue: block === null ? null : parseSeriesQueueBlock(block),
    changedAt: NOW,
    ...over
  };
}

type Answer = ControlFileResult | Error;

function nodes(...bodies: Array<{ id: string; etag: string; body: unknown }>): ControlFileResult {
  return {
    etag: bodies.map((b) => `${b.id}=${b.etag}`).join('|'),
    nodes: bodies.map((b) => ({
      id: b.id,
      etag: b.etag,
      blob: new Blob([typeof b.body === 'string' ? b.body : JSON.stringify(b.body)])
    }))
  };
}

/** A provider whose series file is whatever `answer` says, honouring ifNoneMatch. */
function rig(type = 'google-drive') {
  let answer: Answer = null;
  const readControlFile = vi.fn(async (_name: string, opts?: { ifNoneMatch?: string }) => {
    if (answer instanceof Error) throw answer;
    if (answer && answer !== 'not-modified' && opts?.ifNoneMatch === answer.etag) {
      return 'not-modified' as const;
    }
    return answer;
  });
  let feed: ((name: string, folder?: string) => void) | null = null;
  const provider = {
    type,
    readControlFile,
    ...(type === 'mega'
      ? {
          onControlFileChange: (l: (name: string, folder?: string) => void) => {
            feed = l;
            return () => (feed = null);
          }
        }
      : {})
  } as unknown as SyncProvider;
  let currentHolder: MarkerNodeRecord | null = holder();
  const env = {
    provider: vi.fn(async () => provider),
    scopeOf: async (p: SyncProvider) => p.type,
    bunkoServer: vi.fn(async (): Promise<string | null> => null),
    isV1Server: vi.fn(() => false),
    fallBackToV1: vi.fn(),
    folderFor: (title: string) => title,
    folderListed: vi.fn(() => true),
    holder: vi.fn(() => currentHolder),
    refreshMarker: vi.fn(async () => true),
    watchedKeys: vi.fn((): string[] => []),
    floorS: (t: string) => ({ webdav: 30, 'google-drive': 60, mega: 60, filesystem: 15 })[t] ?? 60,
    onCompleted: vi.fn(),
    isHidden: vi.fn(() => false),
    now: () => Date.now()
  } satisfies SeriesQueueEnv;
  return {
    env,
    readControlFile,
    set: (a: Answer) => (answer = a),
    setHolder: (h: MarkerNodeRecord | null) => (currentHolder = h),
    fire: (name: string, folder?: string) => feed?.(name, folder)
  };
}

const slice = () => get(seriesQueueStore).get(KEY);

let sets = 0;
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  resetSeriesQueueLoopForTest();
  resetSeriesQueueStoreForTest();
  sets = 0;
  unsubscribe = seriesQueueStore.subscribe(() => sets++);
});

afterEach(() => {
  unsubscribe?.();
  resetSeriesQueueLoopForTest();
  resetSeriesQueueStoreForTest();
  vi.useRealTimers();
});

async function open(r: ReturnType<typeof rig>, title = SERIES) {
  const stop = followSeriesQueue(title, r.env);
  await vi.advanceTimersByTimeAsync(0);
  return stop;
}

describe('the store', () => {
  it("a read replaces only its own series' slice", async () => {
    publishSeriesQueueSlice('other series', new Map([['v', { jobs: [], held: null }]]));
    const other = get(seriesQueueStore).get('other series');
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    const stop = await open(r);
    expect(slice()?.get('example saga 01')?.jobs[0]).toMatchObject({
      state: 'queued',
      eta: new Date((S + 600) * 1000).toISOString()
    });
    expect(get(seriesQueueStore).get('other series')).toBe(other);
    stop();
  });

  it('no set on not-modified, nor on equal bytes, nor on a new version that shows the same', async () => {
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    const stop = await open(r);
    const after = sets;
    await vi.advanceTimersByTimeAsync(120_000); // not-modified
    expect(r.readControlFile).toHaveBeenCalledTimes(2);
    r.set(nodes({ id: 'n', etag: '2', body: body() })); // same bytes, new version
    await vi.advanceTimersByTimeAsync(120_000);
    r.set(nodes({ id: 'n', etag: '3', body: body({ rev: 11, at: S + 60 }) })); // same jobs
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(4);
    expect(sets).toBe(after);
    stop();
  });

  it("a changed volume's status is new; an unchanged one keeps its object", async () => {
    const r = rig();
    const two = { 'Example Saga 01': [[0, 'q', S + 600]], 'Example Saga 02': [[0, 'c']] };
    r.set(nodes({ id: 'n', etag: '1', body: body({ vols: two }) }));
    const stop = await open(r);
    const first = slice()!;
    r.set(
      nodes({
        id: 'n',
        etag: '2',
        body: body({ rev: 11, vols: { ...two, 'Example Saga 02': [[0, 'r', S, S + 600]] } })
      })
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(slice()!.get('example saga 01')).toBe(first.get('example saga 01'));
    expect(slice()!.get('example saga 02')).not.toBe(first.get('example saga 02'));
    stop();
  });
});

describe('trust', () => {
  it('a stored copy needs a holder with series_queue, and its instance_id', async () => {
    const r = rig();
    r.setHolder(holder({}, null));
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    let stop = await open(r);
    expect(r.readControlFile).not.toHaveBeenCalled();
    expect(slice()).toBeUndefined();
    stop();

    r.setHolder(holder({ instance_id: 'bbb' }));
    resetSeriesQueueLoopForTest();
    stop = await open(r);
    expect(r.readControlFile).toHaveBeenCalledTimes(1);
    expect(slice()).toBeUndefined();
    stop();
  });

  it('the highest rev wins across fold-equal folders; a lower rev later is a stale replica', async () => {
    const r = rig();
    r.set(
      nodes(
        { id: 'a', etag: '1', body: body({ rev: 7, vols: { 'Example Saga 01': [[0, 'c']] } }) },
        { id: 'b', etag: '1', body: body({ rev: 9 }) },
        { id: 'c', etag: '1', body: body({ rev: 50, instance_id: 'bbb', vols: {} }) }
      )
    );
    const stop = await open(r);
    expect(slice()?.get('example saga 01')?.jobs[0].state).toBe('queued');
    r.set(nodes({ id: 'a', etag: '2', body: body({ rev: 8, vols: {} }) }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(slice()?.get('example saga 01')?.jobs[0].state).toBe('queued');
    stop();
  });

  it('torn JSON keeps the last good copy', async () => {
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    const stop = await open(r);
    r.set(nodes({ id: 'n', etag: '2', body: '{"v":2,"instance_id":"aaa","re' }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(slice()?.get('example saga 01')?.jobs[0].state).toBe('queued');
    expect(r.env.onCompleted).not.toHaveBeenCalled();
    stop();
  });

  it('over a bunko server the virtual file is trusted by its live block, under its own clock', async () => {
    const r = rig('webdav');
    r.env.bunkoServer.mockResolvedValue('https://bunko.example/mokuro-reader/.mokuro-queue.json');
    r.setHolder(null);
    r.set(nodes({ id: 'u', etag: '"e"', body: servedSeriesQueue() }));
    const stop = await open(r, 'Contract Series');
    expect(get(seriesQueueStore).get('contract series')?.get('volume 02')?.jobs[0]).toMatchObject({
      state: 'held',
      eta: null
    });
    expect(r.env.holder).not.toHaveBeenCalled();
    // WebDAV: max(floor 30 s, batch_s 5 s).
    await vi.advanceTimersByTimeAsync(29_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a stored file with a live block is not taken as a bunko server', async () => {
    const r = rig();
    r.setHolder(null);
    r.set(nodes({ id: 'u', etag: '1', body: { ...servedSeriesQueue(), instance_id: 'aaa' } }));
    const stop = await open(r);
    expect(r.readControlFile).not.toHaveBeenCalled();
    expect(slice()).toBeUndefined();
    stop();
  });
});

describe('the v1 fallback', () => {
  const QUEUE = 'https://bunko.example/mokuro-reader/.mokuro-queue.json';

  it('a 404 for a series the listing holds hands the server to its v1 poller', async () => {
    const r = rig('webdav');
    r.env.bunkoServer.mockResolvedValue(QUEUE);
    r.set(null);
    const stop = await open(r);
    expect(r.env.fallBackToV1).toHaveBeenCalledWith(QUEUE, true);
    expect(slice()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a server known to be v1 is not asked again', async () => {
    const r = rig('webdav');
    r.env.bunkoServer.mockResolvedValue(QUEUE);
    r.env.isV1Server.mockReturnValue(true);
    const stop = await open(r);
    expect(r.readControlFile).not.toHaveBeenCalled();
    expect(r.env.fallBackToV1).toHaveBeenCalledWith(QUEUE, false);
    stop();
  });

  it('a 404 for a series the listing does not hold is just nothing owed', async () => {
    const r = rig('webdav');
    r.env.bunkoServer.mockResolvedValue(QUEUE);
    r.env.folderListed.mockReturnValue(false);
    const stop = await open(r);
    expect(r.env.fallBackToV1).not.toHaveBeenCalled();
    expect(slice()?.size).toBe(0);
    stop();
  });
});

describe('when it reads', () => {
  it('stops after 2 reads that show nothing, unless a volume of the series is watched', async () => {
    const r = rig();
    r.set(null);
    const stop = await open(r);
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(2);
    expect(seriesQueueFollower(SERIES)?.waiting).toBe(false);
    stop();

    resetSeriesQueueLoopForTest();
    r.readControlFile.mockClear();
    r.env.watchedKeys.mockReturnValue([`${KEY}\u0000example saga 03`]);
    const again = await open(r);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(r.readControlFile.mock.calls.length).toBeGreaterThan(2);
    again();
  });

  it('keeps reading every max(floor, batch_s) while the slice has jobs', async () => {
    const r = rig('filesystem');
    r.setHolder(holder({}, { ...BLOCK, batch_s: 15 }));
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    const stop = await open(r);
    await vi.advanceTimersByTimeAsync(15_000 * 4);
    expect(r.readControlFile).toHaveBeenCalledTimes(5);
    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(5);
  });

  it('coming back within the interval costs no read', async () => {
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    const stop = await open(r);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    const back = await open(r);
    expect(r.readControlFile).toHaveBeenCalledTimes(1);
    expect(slice()?.size).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000); // due 120 s after the first read
    expect(r.readControlFile).toHaveBeenCalledTimes(2);
    expect(r.readControlFile).toHaveBeenLastCalledWith(FILE, {
      folder: SERIES,
      ifNoneMatch: 'n=1'
    });
    back();
  });

  it('pauses while the tab is hidden, and looks once it is visible again', async () => {
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    const stop = await open(r);
    r.env.isHidden.mockReturnValue(true);
    seriesQueueFollower(SERIES)!.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(1);
    r.env.isHidden.mockReturnValue(false);
    seriesQueueFollower(SERIES)!.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.readControlFile).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a failed read backs off', async () => {
    const r = rig();
    r.set(new Error('offline'));
    const stop = await open(r);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(2);
    stop();
  });

  it('MEGA: its own series file event reads at once; another series or a root file does not', async () => {
    const r = rig('mega');
    r.set(nodes({ id: 'h', etag: 'h1', body: body() }));
    const stop = await open(r);
    expect(seriesQueueFollower(SERIES)?.waiting).toBe(true);
    r.fire(FILE, 'Other Series');
    r.fire('.mokuro-bunko.json');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(1);
    r.fire(FILE, 'example SAGA');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(2);
    // The safety read.
    await vi.advanceTimersByTimeAsync(MEGA_SAFETY_READ_MS);
    expect(r.readControlFile).toHaveBeenCalledTimes(3);
    stop();
  });
});

describe('the clock', () => {
  it('a file newer than the marker clock re-reads the marker, at most once a minute', async () => {
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body({ clock_at: S + 300 }) }));
    const stop = await open(r);
    expect(r.env.refreshMarker).toHaveBeenCalledTimes(1);
    r.set(nodes({ id: 'n', etag: '2', body: body({ clock_at: S + 300, rev: 11 }) }));
    await vi.advanceTimersByTimeAsync(MARKER_REREAD_SPACING_MS - 1);
    // (no read is due yet on Drive; the next one is at 120 s)
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.env.refreshMarker).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a file under the current clock does not', async () => {
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    const stop = await open(r);
    expect(r.env.refreshMarker).not.toHaveBeenCalled();
    stop();
  });
});

describe('completions', () => {
  it('a job gone from the file is handed on with its folder and stem', async () => {
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body() }));
    const stop = await open(r);
    expect(r.env.onCompleted).not.toHaveBeenCalled();
    r.set(
      nodes({
        id: 'n',
        etag: '2',
        body: body({ rev: 11, vols: {}, done: { 'Example Saga 01': S + 30 } })
      })
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.env.onCompleted).toHaveBeenCalledTimes(1);
    expect(r.env.onCompleted.mock.calls[0][0]).toMatchObject({
      bunkoQueueUrl: null,
      folder: SERIES,
      stems: ['Example Saga 01']
    });
    stop();
  });

  it('a file that appears after a read found none names its done volumes, listed or not', async () => {
    // Bunko writes a series' file only for a change it saw: a volume queued and
    // finished within one write window appears only as a `done` entry.
    const r = rig();
    r.set(null);
    const stop = await open(r);
    expect(r.readControlFile).toHaveBeenCalledTimes(1);
    r.set(
      nodes({ id: 'n', etag: '1', body: body({ vols: {}, done: { 'Example Saga 04': S + 60 } }) })
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.readControlFile).toHaveBeenCalledTimes(2);
    expect(r.env.onCompleted).toHaveBeenCalledTimes(1);
    expect(r.env.onCompleted.mock.calls[0][0]).toMatchObject({
      folder: SERIES,
      stems: ['Example Saga 04']
    });
    stop();
  });

  it('a first read reports only watched volumes; the last read is kept for the watch schedule', async () => {
    const r = rig();
    r.set(nodes({ id: 'n', etag: '1', body: body({ done: { 'Example Saga 04': S - 60 } }) }));
    const stop = await open(r);
    expect(r.env.onCompleted).not.toHaveBeenCalled();
    const last = seriesQueueFollower(SERIES)!.lastLook;
    expect(last?.file?.vols.has('Example Saga 01')).toBe(true);
    expect(last?.block?.batch_s).toBe(120);
    stop();
  });
});
