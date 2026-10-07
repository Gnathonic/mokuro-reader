import { describe, expect, it } from 'vitest';
import {
  applyForgetHorizon as applyHorizon,
  mergeLiveVolumeRecords as mergeLive,
  type VolumeRecordLike
} from './volume-record-merge';

type Rec = VolumeRecordLike & {
  archivedReads?: Array<{ at: number; pages: number; chars: number; completed: boolean }>;
  progress?: number;
  chars?: number;
  completed?: boolean;
  lastProgressUpdate?: string;
};
const mergeLiveVolumeRecords = (winner: Rec, loser: Rec) => mergeLive(winner, loser);
const applyForgetHorizon = (record: Rec, forgotAt: string) => applyHorizon(record, forgotAt);

// Shared history both devices synced, then each read on alone.
const synced: [number, number, number][] = [
  [1000, 38, 3800],
  [2000, 39, 3900],
  [3000, 40, 4000]
];

describe('mergeLiveVolumeRecords', () => {
  it("keeps the losing side's page turns, in time order, without duplicates", () => {
    const winner = { progress: 41, recentPageTurns: [...synced, [5000, 41, 4100]] };
    const loser = { progress: 40, recentPageTurns: [...synced] };

    const record = mergeLiveVolumeRecords(winner, loser);

    expect(record.recentPageTurns).toEqual([...synced, [5000, 41, 4100]]);
  });

  it('takes the turns the newer record never saw', () => {
    // The newer save came from a device that never read — e.g. a stat edit.
    const winner = { progress: 40, recentPageTurns: [...synced] };
    const loser = { progress: 40, recentPageTurns: [...synced, [4000, 41, 4100]] };

    const record = mergeLiveVolumeRecords(winner, loser);

    expect(record.recentPageTurns).toEqual([...synced, [4000, 41, 4100]]);
  });

  it('treats a legacy 2-tuple and its migrated 3-tuple as one turn', () => {
    const winner = {
      progress: 2,
      recentPageTurns: [
        [1000, 1],
        [2000, 2, 200]
      ]
    };
    const loser = {
      progress: 2,
      recentPageTurns: [
        [1000, 1, 100],
        [2000, 2]
      ]
    };

    const record = mergeLiveVolumeRecords(winner, loser);

    expect(record.recentPageTurns).toEqual([
      [1000, 1, 100],
      [2000, 2, 200]
    ]);
  });

  it('the newest record keeps the position, even when it is behind', () => {
    // Phone read on to p.120 and synced; the laptop, never pulling that, then
    // opened at p.40 and turned a page. Position = the newest page event.
    const laptop = {
      progress: 41,
      chars: 4100,
      timeReadInMinutes: 150,
      lastProgressUpdate: '2026-10-03T20:00:00.000Z',
      recentPageTurns: [...synced, [9000, 41, 4100]]
    };
    const phone = {
      progress: 120,
      chars: 12000,
      completed: true,
      timeReadInMinutes: 200,
      lastProgressUpdate: '2026-10-03T18:00:00.000Z',
      recentPageTurns: [...synced, [4000, 41, 4100], [8000, 120, 12000]]
    };

    const record = mergeLiveVolumeRecords(laptop, phone);

    expect(record).toMatchObject({
      progress: 41,
      chars: 4100,
      lastProgressUpdate: '2026-10-03T20:00:00.000Z'
    });
    expect(record.completed).toBeUndefined();
    expect(record.recentPageTurns).toEqual([
      ...synced,
      [4000, 41, 4100],
      [8000, 120, 12000],
      [9000, 41, 4100]
    ]);
  });

  it('when both read pages the other never saw, the larger timer survives', () => {
    const winner = {
      progress: 41,
      timeReadInMinutes: 150,
      recentPageTurns: [...synced, [9000, 41, 1]]
    };
    const loser = {
      progress: 120,
      timeReadInMinutes: 200,
      recentPageTurns: [...synced, [8000, 120, 1]]
    };

    expect(mergeLiveVolumeRecords(winner, loser).timeReadInMinutes).toBe(200);
  });

  it("without divergence the winner's timer stands, even when lower (an edit)", () => {
    const winner = { progress: 40, timeReadInMinutes: 60, recentPageTurns: [...synced] };
    const loser = { progress: 40, timeReadInMinutes: 600, recentPageTurns: [...synced] };

    expect(mergeLiveVolumeRecords(winner, loser).timeReadInMinutes).toBe(60);
  });

  it('records without page turns merge as before: the winner, untouched', () => {
    const winner = { progress: 5, timeReadInMinutes: 3 };
    const loser = { progress: 50, timeReadInMinutes: 30 };

    expect(mergeLiveVolumeRecords(winner, loser)).toEqual({ progress: 5, timeReadInMinutes: 3 });
  });

  it('turns from before a forget never come back from a stale copy', () => {
    // This device forgot the stats at 5000 and read again; the stale copy still
    // holds the pre-forget reading.
    const fresh = {
      progress: 2,
      forgotAt: new Date(5000).toISOString(),
      recentPageTurns: [[6000, 2, 20]]
    };
    const stale = { progress: 40, timeReadInMinutes: 90, recentPageTurns: [...synced] };

    const record = mergeLiveVolumeRecords(fresh, stale);

    expect(record.recentPageTurns).toEqual([[6000, 2, 20]]);
    expect(record.forgotAt).toBe(new Date(5000).toISOString());
    expect(record.timeReadInMinutes).toBeUndefined();
  });

  it('keeps the later horizon when the stale copy is the winner', () => {
    const fresh = { progress: 2, forgotAt: new Date(2500).toISOString(), recentPageTurns: [] };
    const stale = { progress: 41, recentPageTurns: [...synced, [9000, 41, 1]] };

    const record = mergeLiveVolumeRecords(stale, fresh);

    expect(record.forgotAt).toBe(new Date(2500).toISOString());
    expect(record.recentPageTurns).toEqual([
      [3000, 40, 4000],
      [9000, 41, 1]
    ]);
  });
});

describe('applyForgetHorizon', () => {
  it('drops turns up to the horizon and records it', () => {
    const record = applyForgetHorizon(
      { progress: 41, recentPageTurns: [...synced, [9000, 41, 1]] },
      new Date(2000).toISOString()
    );

    expect(record.recentPageTurns).toEqual([
      [3000, 40, 4000],
      [9000, 41, 1]
    ]);
    expect(record.forgotAt).toBe(new Date(2000).toISOString());
  });

  it('never moves an existing later horizon back', () => {
    const record = applyForgetHorizon(
      { progress: 1, forgotAt: new Date(8000).toISOString(), recentPageTurns: [[9000, 1, 1]] },
      new Date(2000).toISOString()
    );

    expect(record.forgotAt).toBe(new Date(8000).toISOString());
  });

  it("keeps both sides' archived reads (a restart on the older copy survives)", () => {
    const winner = {
      progress: 60,
      archivedReads: [{ at: 100, pages: 10, chars: 1, completed: true }],
      recentPageTurns: []
    };
    const loser = {
      progress: 0,
      archivedReads: [
        { at: 100, pages: 10, chars: 1, completed: true },
        { at: 500, pages: 200, chars: 9, completed: true }
      ],
      recentPageTurns: []
    } as Rec;
    expect(mergeLiveVolumeRecords(winner as Rec, loser).archivedReads?.map((r) => r.at)).toEqual([
      100, 500
    ]);
  });
});
