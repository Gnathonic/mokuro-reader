import { describe, expect, it } from 'vitest';
import {
  POSITION_WINDOW_MS,
  composePositionsFile,
  positionsContent,
  type PositionEntry,
  type PositionsMap
} from './positions-file';
import { reconcilePositions, type LocalPosition, type ReconcileInput } from './positions-reconcile';

const now = Date.parse('2026-10-16T12:00:00Z');
const at = (offset: number) => now - 100_000 + offset;

function entry(t: number, page = 120, device = 'other'): PositionEntry {
  return { t, page, chars: page * 10, device };
}

function input(
  over: Partial<ReconcileInput> & { locals?: Record<string, LocalPosition> }
): ReconcileInput {
  const locals = over.locals ?? {};
  const cloud = over.cloud ?? {};
  return {
    cloud,
    cloudContent: over.cloudContent ?? (Object.keys(cloud).length ? contentOf(cloud) : ''),
    local: over.local ?? ((v) => locals[v]),
    own: over.own ?? {},
    ownDevice: over.ownDevice ?? 'me',
    open: over.open ?? null,
    now: over.now ?? now
  };
}

function contentOf(map: PositionsMap): string {
  return positionsContent(JSON.parse(JSON.stringify(composePositionsFile(map))));
}

describe('reconcilePositions: adopt', () => {
  it('adopts a newer remote position for a closed volume', () => {
    const r = reconcilePositions(
      input({
        cloud: { v: entry(at(300)) },
        locals: { v: { stamp: at(100), deleted: false, forgotAt: 0 } }
      })
    );
    expect(r.adopt).toEqual([{ volume: 'v', entry: entry(at(300)), toast: false }]);
    expect(r.deferred).toEqual([]);
  });

  it('adopts for a volume this device has no record of', () => {
    const r = reconcilePositions(input({ cloud: { v: entry(at(300)) } }));
    expect(r.adopt.map((a) => a.volume)).toEqual(['v']);
  });

  it('never adopts its own device, an older entry, or a page-0 reset', () => {
    const locals = { v: { stamp: at(500), deleted: false, forgotAt: 0 } };
    expect(
      reconcilePositions(input({ cloud: { v: entry(at(600), 120, 'me') }, locals })).adopt
    ).toEqual([]);
    expect(reconcilePositions(input({ cloud: { v: entry(at(400)) }, locals })).adopt).toEqual([]);
    expect(reconcilePositions(input({ cloud: { v: entry(at(500)) }, locals })).adopt).toEqual([]);
    expect(reconcilePositions(input({ cloud: { v: entry(at(600), 0) }, locals })).adopt).toEqual(
      []
    );
  });

  it('never resurrects a deleted volume or reading before a forget', () => {
    expect(
      reconcilePositions(
        input({
          cloud: { v: entry(at(300)) },
          locals: { v: { stamp: 5, deleted: true, forgotAt: 0 } }
        })
      ).adopt
    ).toEqual([]);
    const forgot = { v: { stamp: 0, deleted: false, forgotAt: at(50) } };
    expect(
      reconcilePositions(input({ cloud: { v: entry(at(40)) }, locals: forgot })).adopt
    ).toEqual([]);
    expect(
      reconcilePositions(input({ cloud: { v: entry(at(50)) }, locals: forgot })).adopt
    ).toEqual([]);
    expect(
      reconcilePositions(input({ cloud: { v: entry(at(60)) }, locals: forgot })).adopt.map(
        (a) => a.volume
      )
    ).toEqual(['v']);
  });

  it('open volume, no page turned since opening: adopt with a toast', () => {
    const r = reconcilePositions(
      input({
        cloud: { v: entry(at(300)) },
        locals: { v: { stamp: at(100), deleted: false, forgotAt: 0 } },
        open: { volume: 'v', openedAt: at(500) }
      })
    );
    expect(r.adopt).toEqual([{ volume: 'v', entry: entry(at(300)), toast: true }]);
  });

  it('open volume, a page turned after opening: deferred, not adopted', () => {
    const locals = { v: { stamp: at(600), deleted: false, forgotAt: 0 } };
    const open = { volume: 'v', openedAt: at(500) };
    const older = reconcilePositions(input({ cloud: { v: entry(at(300)) }, locals, open }));
    expect(older.adopt).toEqual([]);
    expect(older.deferred).toEqual([]);
    const newer = reconcilePositions(input({ cloud: { v: entry(at(700)) }, locals, open }));
    expect(newer.adopt).toEqual([]);
    expect(newer.deferred).toEqual(['v']);
  });

  it('an open volume never read on this device adopts with a toast', () => {
    const r = reconcilePositions(
      input({ cloud: { v: entry(at(300)) }, open: { volume: 'v', openedAt: at(500) } })
    );
    expect(r.adopt).toEqual([{ volume: 'v', entry: entry(at(300)), toast: true }]);
  });
});

describe('reconcilePositions: next and upload', () => {
  it('next is the pruned merge of cloud and own', () => {
    const r = reconcilePositions(
      input({
        cloud: { a: entry(at(100)), old: entry(now - POSITION_WINDOW_MS - 1) },
        own: { a: entry(at(200), 5, 'me'), b: entry(at(300), 6, 'me') }
      })
    );
    expect(r.next).toEqual({ a: entry(at(200), 5, 'me'), b: entry(at(300), 6, 'me') });
  });

  it('uploads only when merged+pruned content differs from the cloud', () => {
    const cloud = { v: entry(at(100)) };
    expect(reconcilePositions(input({ cloud, own: { v: entry(at(200), 5, 'me') } })).upload).toBe(
      true
    );
    expect(reconcilePositions(input({ cloud })).upload).toBe(false);
    // An own entry older than the cloud's changes nothing.
    expect(reconcilePositions(input({ cloud, own: { v: entry(at(50), 5, 'me') } })).upload).toBe(
      false
    );
  });

  it('a cloud copy holding a bogus or expired entry heals', () => {
    const cloud = { v: entry(at(100)) };
    const raw = JSON.parse(JSON.stringify(composePositionsFile(cloud)));
    raw.positions.bogus = [now + 3_600_000, 5, 50, 'fast']; // dropped by parse
    expect(reconcilePositions(input({ cloud, cloudContent: positionsContent(raw) })).upload).toBe(
      true
    );
    const expired = { ...cloud, old: entry(now - POSITION_WINDOW_MS - 1) };
    expect(reconcilePositions(input({ cloud: expired })).upload).toBe(true);
  });

  it('an unparseable cloud file (cloud {}, cloudContent "") with own entries → upload true', () => {
    const r = reconcilePositions(
      input({ cloud: {}, cloudContent: '', own: { v: entry(at(1), 3, 'me') } })
    );
    expect(r.upload).toBe(true);
  });

  it('no cloud file and nothing of its own → no upload (no empty file is minted)', () => {
    expect(reconcilePositions(input({})).upload).toBe(false);
  });

  it('a cloud file whose every entry expired is rewritten empty', () => {
    const r = reconcilePositions(input({ cloud: { old: entry(now - POSITION_WINDOW_MS - 1) } }));
    expect(r.next).toEqual({});
    expect(r.upload).toBe(true);
  });
});
