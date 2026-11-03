import { describe, expect, it } from 'vitest';
import {
  classifyVolumeDataDiff,
  planVolumeDataUpload,
  stableStringify,
  type VolumeDataSide,
  type VolumeDataUploadInput
} from './volume-data-deferral';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T10:05:00.000Z';
const T1_MS = Date.parse(T1);

/** A read record as the cloud holds it. */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    progress: 40,
    chars: 4000,
    completed: false,
    lastProgressUpdate: T0,
    series_title: 'S',
    volume_title: 'V1',
    addedOn: '2026-10-01T00:00:00.000Z',
    ...over
  };
}

/** The same record after a page turn here. */
const turned = (over: Record<string, unknown> = {}) =>
  record({ progress: 44, chars: 4400, lastProgressUpdate: T1, ...over });

function side(volumes: Record<string, unknown>, sections: unknown = {}): VolumeDataSide {
  return { volumes, sections };
}

/** Every clause satisfied: an in-session turn on plain storage, pushed through positions.json. */
function input(over: Partial<VolumeDataUploadInput> = {}): VolumeDataUploadInput {
  return {
    next: side({ a: turned() }),
    cloud: side({ a: record() }),
    sessionActive: true,
    status: {},
    legacyCarried: true,
    markOf: () => T1_MS,
    cloudPositionOf: () => undefined,
    ...over
  };
}

describe('classifyVolumeDataDiff', () => {
  it('identical files (key order aside) are the same', () => {
    const a = { lastProgressUpdate: T0, progress: 40 };
    const b = { progress: 40, lastProgressUpdate: T0 };
    expect(classifyVolumeDataDiff(side({ a }), side({ a: b }))).toEqual({ kind: 'same' });
  });

  it('a page turn (progress, chars, stamp) is position-only', () => {
    expect(
      classifyVolumeDataDiff(side({ a: turned(), b: record() }), side({ a: record(), b: record() }))
    ).toEqual({
      kind: 'position-only',
      volumes: ['a']
    });
  });

  // positions.json entries are `[t, page, chars, device]`: no `completed`. An
  // adopting device keeps its own flag for any volume it does not have open,
  // so only volume-data.json carries the flip, and it must not wait.
  it('a `completed` flip is not position-only, even with the same completedAt', () => {
    const cloud = record({ completed: true, completedAt: '2026-10-20T00:00:00.000Z' });
    const next = turned({ completed: false, completedAt: '2026-10-20T00:00:00.000Z' });
    expect(classifyVolumeDataDiff(side({ a: next }), side({ a: cloud })).kind).toBe('other');
    const reRead = record({ completed: false, completedAt: '2026-10-20T00:00:00.000Z' });
    const finishedAgain = turned({ completed: true, completedAt: '2026-10-20T00:00:00.000Z' });
    expect(classifyVolumeDataDiff(side({ a: finishedAgain }), side({ a: reRead })).kind).toBe(
      'other'
    );
  });

  it('a completedAt change is not position-only, whichever way', () => {
    const stamped = turned({ completed: true, completedAt: T1 });
    expect(classifyVolumeDataDiff(side({ a: stamped }), side({ a: record() })).kind).toBe('other');
    const cleared = turned();
    const before = record({ completedAt: '2026-10-20T00:00:00.000Z' });
    expect(classifyVolumeDataDiff(side({ a: cleared }), side({ a: before })).kind).toBe('other');
  });

  it.each([
    ['settings', { settings: { rightToLeft: false } }],
    ['volume_title', { volume_title: 'Renamed' }],
    ['deletedOn', { deletedOn: T1 }],
    ['forgotAt', { forgotAt: T1 }],
    ['archivedReads', { archivedReads: [{ at: T0 }] }],
    ['recentPageTurns', { recentPageTurns: [[1, 2, 3]] }],
    ['timeReadInMinutes', { timeReadInMinutes: 5 }]
  ])('any other field (%s) is not position-only', (_name, change) => {
    expect(classifyVolumeDataDiff(side({ a: turned(change) }), side({ a: record() })).kind).toBe(
      'other'
    );
  });

  it('a record only on one side is not position-only, in both directions', () => {
    expect(
      classifyVolumeDataDiff(side({ a: record(), b: turned() }), side({ a: record() })).kind
    ).toBe('other');
    expect(
      classifyVolumeDataDiff(side({ a: record() }), side({ a: record(), b: turned() })).kind
    ).toBe('other');
  });

  it('a first read (0 → n) and a reset (n → 0) are not position-only', () => {
    const unread = record({ progress: 0, chars: 0 });
    delete unread.progress; // `toJSON` omits progress at 0
    expect(classifyVolumeDataDiff(side({ a: turned() }), side({ a: unread })).kind).toBe('other');
    const reset = turned({ progress: 0, chars: 0 });
    expect(classifyVolumeDataDiff(side({ a: reset }), side({ a: record() })).kind).toBe('other');
  });

  it('a series or tracking section difference is not position-only, in both directions', () => {
    const series = { series: { s: { read_count: 1, lastUpdated: T0 } } };
    expect(classifyVolumeDataDiff(side({ a: turned() }, series), side({ a: record() })).kind).toBe(
      'other'
    );
    expect(classifyVolumeDataDiff(side({ a: turned() }), side({ a: record() }, series)).kind).toBe(
      'other'
    );
  });

  it('applies `toJSON`, the way the file is written', () => {
    const asInstance = { toJSON: () => record() };
    expect(classifyVolumeDataDiff(side({ a: asInstance }), side({ a: record() }))).toEqual({
      kind: 'same'
    });
  });
});

describe('planVolumeDataUpload', () => {
  it('defers an in-session, covered page turn', () => {
    expect(planVolumeDataUpload(input())).toEqual({ action: 'defer', volumes: ['a'] });
  });

  it('nothing differs: nothing to upload', () => {
    expect(
      planVolumeDataUpload(input({ next: side({ a: record() }), cloud: side({ a: record() }) }))
    ).toEqual({ action: 'none' });
  });

  it('a change beyond the position uploads', () => {
    expect(
      planVolumeDataUpload(input({ next: side({ a: turned({ volume_title: 'X' }) }) }))
    ).toEqual({ action: 'upload', reason: 'not-position-only' });
  });

  it('no reading session: uploads (the flush that ends a session)', () => {
    expect(planVolumeDataUpload(input({ sessionActive: false }))).toEqual({
      action: 'upload',
      reason: 'no-session'
    });
  });

  it.each([
    ['history off (explicit)', { historySync: false }, 'history-off'],
    [
      'history off (bunko, version unknown)',
      { serverCompilesMetadata: true, positionsSync: true },
      'history-off'
    ],
    ['read-only', { isReadOnly: true }, 'read-only'],
    ['positions off', { positionsSync: false }, 'positions-off'],
    [
      'positions off (bunko without per-user positions)',
      { serverCompilesMetadata: true, historySync: true },
      'positions-off'
    ]
  ] as const)('%s: uploads', (_name, status, reason) => {
    expect(planVolumeDataUpload(input({ status }))).toEqual({ action: 'upload', reason });
  });

  it('bunko with history and per-user positions defers', () => {
    const status = { serverCompilesMetadata: true, historySync: true, positionsSync: true };
    expect(planVolumeDataUpload(input({ status })).action).toBe('defer');
  });

  it('legacy turns not yet held as history: uploads (the file still carries them)', () => {
    expect(planVolumeDataUpload(input({ legacyCarried: false }))).toEqual({
      action: 'upload',
      reason: 'legacy-turns'
    });
  });

  describe('covered by positions.json', () => {
    // The push sends a volume only when its record's stamp IS the mark
    // (`ownChangedEntries`), and clears any other mark (`clearChanged`). A
    // mark above the stamp is what a look-up restore leaves behind
    // (`visit.ts` puts the old stamp back and keeps the mark): nothing is on
    // its way, so it covers nothing.
    it('only a changed-mark AT the record stamp covers it; an older or newer one does not', () => {
      expect(planVolumeDataUpload(input({ markOf: () => T1_MS })).action).toBe('defer');
      for (const mark of [T1_MS - 1, T1_MS + 1]) {
        expect(planVolumeDataUpload(input({ markOf: () => mark }))).toEqual({
          action: 'upload',
          reason: 'not-covered'
        });
      }
    });

    it('a cloud positions entry at or past the stamp covers it; an older one does not', () => {
      const noMark = { markOf: () => undefined };
      expect(planVolumeDataUpload(input({ ...noMark, cloudPositionOf: () => T1_MS })).action).toBe(
        'defer'
      );
      expect(
        planVolumeDataUpload(input({ ...noMark, cloudPositionOf: () => T1_MS + 5 })).action
      ).toBe('defer');
      expect(planVolumeDataUpload(input({ ...noMark, cloudPositionOf: () => T1_MS - 1 }))).toEqual({
        action: 'upload',
        reason: 'not-covered'
      });
    });

    it('neither a mark nor a cloud entry: uploads', () => {
      expect(
        planVolumeDataUpload(input({ markOf: () => undefined, cloudPositionOf: () => undefined }))
      ).toEqual({ action: 'upload', reason: 'not-covered' });
    });

    it('every moved volume must be covered, not just one', () => {
      const next = side({ a: turned(), b: turned() });
      const cloud = side({ a: record(), b: record() });
      const markOf = (v: string) => (v === 'a' ? T1_MS : undefined);
      expect(planVolumeDataUpload(input({ next, cloud, markOf }))).toEqual({
        action: 'upload',
        reason: 'not-covered'
      });
      expect(planVolumeDataUpload(input({ next, cloud, markOf: () => T1_MS }))).toEqual({
        action: 'defer',
        volumes: ['a', 'b']
      });
    });

    it('a record with no usable stamp is never covered', () => {
      const next = side({ a: turned({ lastProgressUpdate: 'garbage' }) });
      expect(
        planVolumeDataUpload(input({ next, markOf: () => 0, cloudPositionOf: () => 0 }))
      ).toEqual({ action: 'upload', reason: 'not-covered' });
    });
  });
});

describe('stableStringify', () => {
  it('ignores key order at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: [{ y: 1, x: 2 }] } })).toBe(
      stableStringify({ a: { c: [{ x: 2, y: 1 }], d: 1 }, b: 1 })
    );
  });
});
