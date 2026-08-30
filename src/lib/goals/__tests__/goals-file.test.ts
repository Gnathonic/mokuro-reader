import { describe, expect, it } from 'vitest';
import {
  composeGoalsFile,
  detectBogusGoalKeys,
  emptySections,
  mergeGoalSection,
  mergeSnapshotEntries,
  mergeSnapshotSections,
  nextGoalTimestamp,
  parseCustomGoals,
  parseGoalsFile,
  parseTargets,
  parseVolumeDeadlines,
  purgeGoalTombstones,
  type GoalSnapshotEntry,
  type GoalTargetEntry
} from '../goals-file';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function target(over: Partial<GoalTargetEntry> = {}): GoalTargetEntry {
  return {
    goalType: 'year',
    periodKey: '2026',
    targetVolumes: 52,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    ...over
  };
}

describe('parseTargets', () => {
  it('keeps a well-formed entry', () => {
    const parsed = parseTargets({ 'year:2026': target() }, NOW);
    expect(parsed['year:2026'].targetVolumes).toBe(52);
  });

  it('drops a target whose count would render as NaN%', () => {
    for (const bad of [Number.NaN, 0, -3, 2.5, '52']) {
      expect(parseTargets({ 'year:2026': target({ targetVolumes: bad as number }) }, NOW)).toEqual(
        {}
      );
    }
  });

  it('drops an unknown goal type and an empty key', () => {
    expect(parseTargets({ 'x:1': target({ goalType: 'decade' as never }) }, NOW)).toEqual({});
    expect(parseTargets({ '  ': target() }, NOW)).toEqual({});
  });

  it('clamps a future cloud stamp and makes an unparseable one lose every merge', () => {
    const future = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
    expect(parseTargets({ k: target({ lastUpdated: future }) }, NOW).k.lastUpdated).toBe(
      new Date(NOW).toISOString()
    );
    expect(parseTargets({ k: target({ lastUpdated: 'nonsense' }) }, NOW).k.lastUpdated).toBe(
      new Date(0).toISOString()
    );
  });
});

describe('parseCustomGoals / parseVolumeDeadlines', () => {
  it('rejects an impossible calendar date and an inverted range', () => {
    const base = {
      id: 'a',
      name: 'Summer',
      targetVolumes: 8,
      enabled: true,
      createdAt: '2026-06-01T00:00:00.000Z',
      lastUpdated: '2026-06-01T00:00:00.000Z'
    };
    expect(
      parseCustomGoals({ a: { ...base, startDate: '2026-02-31', endDate: '2026-08-31' } }, NOW)
    ).toEqual({});
    expect(
      parseCustomGoals({ a: { ...base, startDate: '2026-09-01', endDate: '2026-08-31' } }, NOW)
    ).toEqual({});
    expect(
      Object.keys(
        parseCustomGoals({ a: { ...base, startDate: '2026-06-01', endDate: '2026-08-31' } }, NOW)
      )
    ).toEqual(['a']);
  });

  it('rejects a deadline that is not a real YYYY-MM-DD', () => {
    expect(parseVolumeDeadlines({ v: { deadline: 'soon', lastUpdated: '' } }, NOW)).toEqual({});
    expect(
      Object.keys(parseVolumeDeadlines({ v: { deadline: '2026-09-15', lastUpdated: '' } }, NOW))
    ).toEqual(['v']);
  });
});

describe('detectBogusGoalKeys', () => {
  it('flags a key whose raw stamp is beyond the clock-skew tolerance', () => {
    const future = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
    expect([...detectBogusGoalKeys({ a: { lastUpdated: future } }, NOW)]).toEqual(['a']);
  });

  it('flags a bogus tombstone too, so it cannot delete a live local entry', () => {
    const future = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
    expect([
      ...detectBogusGoalKeys(
        { a: { lastUpdated: '2026-01-01T00:00:00.000Z', deletedOn: future } },
        NOW
      )
    ]).toEqual(['a']);
  });

  it('does not flag a stamp inside the tolerance window', () => {
    const soon = new Date(NOW + 60 * 1000).toISOString();
    expect(detectBogusGoalKeys({ a: { lastUpdated: soon } }, NOW).size).toBe(0);
  });
});

describe('mergeGoalSection', () => {
  it('takes the newer cloud entry and keeps local on a tie', () => {
    const local = { k: target({ targetVolumes: 10, lastUpdated: '2026-05-01T00:00:00.000Z' }) };
    const newer = { k: target({ targetVolumes: 20, lastUpdated: '2026-06-01T00:00:00.000Z' }) };
    const older = { k: target({ targetVolumes: 30, lastUpdated: '2026-04-01T00:00:00.000Z' }) };
    const tie = { k: target({ targetVolumes: 40, lastUpdated: '2026-05-01T00:00:00.000Z' }) };

    expect(mergeGoalSection(local, newer).k.targetVolumes).toBe(20);
    expect(mergeGoalSection(local, older).k.targetVolumes).toBe(10);
    expect(mergeGoalSection(local, tie).k.targetVolumes).toBe(10);
  });

  it('propagates a delete, so a goal removed on one device stays removed', () => {
    const local = { k: target({ lastUpdated: '2026-05-01T00:00:00.000Z' }) };
    const deleted = {
      k: target({ lastUpdated: '2026-05-01T00:00:00.000Z', deletedOn: '2026-06-01T00:00:00.000Z' })
    };
    expect(mergeGoalSection(local, deleted).k.deletedOn).toBe('2026-06-01T00:00:00.000Z');
  });

  it('prefers a live cloud entry over a local tombstone on an exact tie', () => {
    const stamp = '2026-05-01T00:00:00.000Z';
    const local = { k: target({ lastUpdated: stamp, deletedOn: stamp }) };
    const live = { k: target({ lastUpdated: stamp }) };
    expect(mergeGoalSection(local, live).k.deletedOn).toBeUndefined();
  });

  it('FORFEIT-ON-BOGUS: a poisoned key never outranks an existing local entry', () => {
    const local = { k: target({ targetVolumes: 10, lastUpdated: '2026-05-01T00:00:00.000Z' }) };
    // Already clamped by the parse, so on stamps alone it would tie-or-beat local.
    const clamped = { k: target({ targetVolumes: 99, lastUpdated: new Date(NOW).toISOString() }) };

    expect(mergeGoalSection(local, clamped).k.targetVolumes).toBe(99);
    expect(mergeGoalSection(local, clamped, new Set(['k'])).k.targetVolumes).toBe(10);
  });

  it('still adopts a bogus key when local has no entry to protect', () => {
    const clamped = { k: target({ targetVolumes: 99 }) };
    expect(mergeGoalSection({}, clamped, new Set(['k'])).k.targetVolumes).toBe(99);
  });
});

describe('mergeSnapshotSections', () => {
  function snap(over: Partial<GoalSnapshotEntry> = {}): GoalSnapshotEntry {
    return {
      goalType: 'year',
      periodKey: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      closedAt: '2027-01-01T00:00:00.000Z',
      completed: {},
      partialProgress: {},
      lastUpdated: '2027-01-01T00:00:00.000Z',
      ...over
    };
  }

  it('unions completions instead of letting the poorer snapshot win', () => {
    // The laptop last synced in November and knows 1 of the 2 volumes; under
    // plain newest-wins its snapshot would erase the phone's.
    const phone = snap({
      completed: { a: '2026-03-01T00:00:00.000Z', b: '2026-07-01T00:00:00.000Z' },
      lastUpdated: '2026-12-31T00:00:00.000Z'
    });
    const laptop = snap({
      completed: { a: '2026-03-01T00:00:00.000Z' },
      lastUpdated: '2027-01-02T00:00:00.000Z'
    });

    expect(Object.keys(mergeSnapshotEntries(phone, laptop).completed).sort()).toEqual(['a', 'b']);
    expect(Object.keys(mergeSnapshotEntries(laptop, phone).completed).sort()).toEqual(['a', 'b']);
  });

  it('is order-independent, which newest-wins is not', () => {
    const a = snap({ completed: { x: '2026-02-01T00:00:00.000Z' }, partialProgress: { p: 0.4 } });
    const b = snap({ completed: { y: '2026-05-01T00:00:00.000Z' }, partialProgress: { p: 0.9 } });

    const ab = mergeSnapshotSections({ k: a }, { k: b }).k;
    const ba = mergeSnapshotSections({ k: b }, { k: a }).k;

    expect(ab.completed).toEqual(ba.completed);
    expect(ab.partialProgress).toEqual(ba.partialProgress);
    expect(ab.partialProgress.p).toBe(0.9);
  });

  it('keeps the earlier completion claim and the earlier close', () => {
    const early = snap({
      completed: { x: '2026-02-01T00:00:00.000Z' },
      closedAt: '2027-01-01T00:00:00.000Z'
    });
    const late = snap({
      completed: { x: '2026-06-01T00:00:00.000Z' },
      closedAt: '2027-01-05T00:00:00.000Z'
    });
    const merged = mergeSnapshotEntries(early, late);
    expect(merged.completed.x).toBe('2026-02-01T00:00:00.000Z');
    expect(merged.closedAt).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('purgeGoalTombstones', () => {
  it('drops tombstones past the TTL and keeps fresh ones and all snapshots', () => {
    const old = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    const sections = {
      ...emptySections(),
      targets: {
        stale: target({ deletedOn: old }),
        recent: target({ deletedOn: fresh }),
        live: target()
      }
    };

    expect(Object.keys(purgeGoalTombstones(sections, NOW).targets).sort()).toEqual([
      'live',
      'recent'
    ]);
  });
});

describe('composeGoalsFile', () => {
  it('omits empty sections so an unused library produces identical bytes everywhere', () => {
    const file = composeGoalsFile(emptySections(), '2026-08-30T12:00:00.000Z');
    expect(file).toEqual({ version: 1, updated_at: '2026-08-30T12:00:00.000Z' });
  });

  it('round-trips through parseGoalsFile', () => {
    const sections = { ...emptySections(), targets: { 'year:2026': target() } };
    const file = composeGoalsFile(sections, '2026-08-30T12:00:00.000Z');
    expect(parseGoalsFile(JSON.parse(JSON.stringify(file)), NOW)).toEqual(sections);
  });
});

describe('nextGoalTimestamp', () => {
  it('beats a stored stamp from a device with a fast clock', () => {
    const future = new Date(NOW + 60 * 60 * 1000).toISOString();
    expect(Date.parse(nextGoalTimestamp(future, NOW))).toBe(Date.parse(future) + 1);
    expect(nextGoalTimestamp('2020-01-01T00:00:00.000Z', NOW)).toBe(new Date(NOW).toISOString());
  });
});
