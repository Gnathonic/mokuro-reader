import { describe, expect, it } from 'vitest';
import { planProgressPush, type LocalPassState, type RemoteEntry } from './progress-plan';

const local = (over: Partial<LocalPassState> = {}): LocalPassState => ({
  passProgress: 0,
  allCompleted: false,
  passComplete: false,
  timesRead: 0,
  rereading: false,
  ...over
});
const remote = (over: Partial<RemoteEntry> = {}): RemoteEntry => ({
  status: null,
  progress: 0,
  progressVolumes: 0,
  repeat: 0,
  ...over
});

describe('planProgressPush', () => {
  it('first read: pushes CURRENT with progressVolumes when local is ahead', () => {
    expect(planProgressPush(local({ passProgress: 3 }), remote(), 'volumes', 'completion')).toEqual(
      {
        status: 'CURRENT',
        progressVolumes: 3
      }
    );
  });

  it('uses the chapter field for the chapters unit', () => {
    expect(
      planProgressPush(
        local({ passProgress: 12 }),
        remote({ progress: 5 }),
        'chapters',
        'completion'
      )
    ).toEqual({ status: 'CURRENT', progress: 12 });
  });

  it('remote null behaves like an empty entry', () => {
    expect(planProgressPush(local({ passProgress: 1 }), null, 'volumes', 'completion')).toEqual({
      status: 'CURRENT',
      progressVolumes: 1
    });
  });

  it('is a no-op when remote is ahead or equal', () => {
    expect(
      planProgressPush(
        local({ passProgress: 3 }),
        remote({ progressVolumes: 5 }),
        'volumes',
        'completion'
      )
    ).toBeNull();
    expect(
      planProgressPush(
        local({ passProgress: 5 }),
        remote({ progressVolumes: 5 }),
        'volumes',
        'sync'
      )
    ).toBeNull();
  });

  it('pass complete: COMPLETED and repeat = timesRead - 1', () => {
    // second full read finished: read_count 1 + allCompleted → timesRead 2
    expect(
      planProgressPush(
        local({
          passProgress: 20,
          allCompleted: true,
          passComplete: true,
          timesRead: 2,
          rereading: false
        }),
        remote({ status: 'REPEATING', progressVolumes: 19, repeat: 0 }),
        'volumes',
        'completion'
      )
    ).toEqual({ status: 'COMPLETED', progressVolumes: 20, repeat: 1 });
  });

  it('first completion pushes COMPLETED without a repeat bump', () => {
    expect(
      planProgressPush(
        local({ passProgress: 20, allCompleted: true, passComplete: true, timesRead: 1 }),
        remote({ status: 'CURRENT', progressVolumes: 19 }),
        'volumes',
        'completion'
      )
    ).toEqual({ status: 'COMPLETED', progressVolumes: 20 });
  });

  it('restart: REPEATING with an explicit 0 even though remote is ahead', () => {
    // after restart of a once-read series: read_count 1, nothing completed → timesRead 1
    expect(
      planProgressPush(
        local({ passProgress: 0, timesRead: 1, rereading: true }),
        remote({ status: 'COMPLETED', progressVolumes: 20, repeat: 0 }),
        'volumes',
        'restart'
      )
    ).toEqual({ status: 'REPEATING', progressVolumes: 0 });
  });

  it('re-read completions push REPEATING while the pass is in flight', () => {
    expect(
      planProgressPush(
        local({ passProgress: 2, timesRead: 1, rereading: true }),
        remote({ status: 'REPEATING', progressVolumes: 0 }),
        'volumes',
        'completion'
      )
    ).toEqual({ status: 'REPEATING', progressVolumes: 2 });
  });

  it('bumps repeat only when it would increase', () => {
    // manual +1 on read count while remote already at repeat 3
    expect(
      planProgressPush(
        local({ passProgress: 20, allCompleted: true, passComplete: true, timesRead: 3 }),
        remote({ status: 'COMPLETED', progressVolumes: 20, repeat: 3 }),
        'volumes',
        'sync'
      )
    ).toBeNull();
    expect(
      planProgressPush(
        local({ passProgress: 20, allCompleted: true, passComplete: true, timesRead: 5 }),
        remote({ status: 'COMPLETED', progressVolumes: 20, repeat: 3 }),
        'volumes',
        'sync'
      )
    ).toEqual({ repeat: 4 });
  });

  it('never returns an empty plan object', () => {
    expect(planProgressPush(local(), remote(), 'volumes', 'sync')).toBeNull();
  });

  it('treats a null remote progress value as 0 (GraphQL may omit it)', () => {
    expect(
      planProgressPush(
        local({ passProgress: 1 }),
        remote({ progressVolumes: null as any }),
        'volumes',
        'completion'
      )
    ).toEqual({ status: 'CURRENT', progressVolumes: 1 });
  });

  describe('restart idempotence', () => {
    it('is a no-op when remote already reflects the restart', () => {
      expect(
        planProgressPush(
          local({ passProgress: 0, timesRead: 1, rereading: true }),
          remote({ status: 'REPEATING', progressVolumes: 0, repeat: 0 }),
          'volumes',
          'restart'
        )
      ).toBeNull();
    });

    it('is still a no-op when the remote repeat already exceeds desired', () => {
      expect(
        planProgressPush(
          local({ passProgress: 0, timesRead: 3, rereading: true }),
          remote({ status: 'REPEATING', progressVolumes: 0, repeat: 5 }),
          'volumes',
          'restart'
        )
      ).toBeNull();
    });

    it('still creates an entry when nothing is tracked yet', () => {
      expect(
        planProgressPush(
          local({ passProgress: 0, timesRead: 1, rereading: true }),
          null,
          'volumes',
          'restart'
        )
      ).toEqual({ status: 'REPEATING', progressVolumes: 0 });
    });
  });

  describe('status-only upgrades when progress does not advance', () => {
    it('flips a CURRENT remote to COMPLETED when the pass completes without a progress bump', () => {
      expect(
        planProgressPush(
          local({ passProgress: 20, allCompleted: true, passComplete: true, timesRead: 1 }),
          remote({ status: 'CURRENT', progressVolumes: 20 }),
          'volumes',
          'completion'
        )
      ).toEqual({ status: 'COMPLETED' });
    });

    it('does not re-push COMPLETED when remote already reflects it', () => {
      expect(
        planProgressPush(
          local({ passProgress: 20 }),
          remote({ status: 'COMPLETED', progressVolumes: 20 }),
          'volumes',
          'sync'
        )
      ).toBeNull();
    });

    it('remote null + completion of 1 still pushes CURRENT progress (unchanged base case)', () => {
      expect(planProgressPush(local({ passProgress: 1 }), null, 'volumes', 'completion')).toEqual({
        status: 'CURRENT',
        progressVolumes: 1
      });
    });

    it('upgrades COMPLETED even from a PAUSED/DROPPED remote status', () => {
      expect(
        planProgressPush(
          local({ passProgress: 20, allCompleted: true, passComplete: true, timesRead: 1 }),
          remote({ status: 'DROPPED', progressVolumes: 20 }),
          'volumes',
          'sync'
        )
      ).toEqual({ status: 'COMPLETED' });
    });

    it('flips a CURRENT remote to REPEATING when rereading without a progress bump yet', () => {
      expect(
        planProgressPush(
          local({ passProgress: 0, timesRead: 1, rereading: true }),
          remote({ status: 'CURRENT', progressVolumes: 0 }),
          'volumes',
          'sync'
        )
      ).toEqual({ status: 'REPEATING' });
    });

    it('flips an untracked (null status) remote to REPEATING when rereading', () => {
      expect(
        planProgressPush(
          local({ passProgress: 0, timesRead: 1, rereading: true }),
          remote({ status: null, progressVolumes: 0 }),
          'volumes',
          'sync'
        )
      ).toEqual({ status: 'REPEATING' });
    });

    it('leaves a PAUSED/DROPPED/PLANNING remote alone for REPEATING without a progress bump', () => {
      expect(
        planProgressPush(
          local({ passProgress: 0, timesRead: 1, rereading: true }),
          remote({ status: 'PAUSED', progressVolumes: 0 }),
          'volumes',
          'sync'
        )
      ).toBeNull();
    });
  });
});

describe('read_count corrections', () => {
  const tracked = (over: Partial<RemoteEntry> = {}): RemoteEntry => ({
    status: 'CURRENT',
    progress: 0,
    progressVolumes: 3,
    repeat: 2,
    ...over
  });

  it('raises the repeat count', () => {
    expect(planProgressPush(local({ timesRead: 4 }), tracked(), 'volumes', 'read_count')).toEqual({
      repeat: 3
    });
  });

  it('lowers the repeat count — the user typed the number on purpose', () => {
    expect(planProgressPush(local({ timesRead: 1 }), tracked(), 'volumes', 'read_count')).toEqual({
      repeat: 0
    });
  });

  it('is a no-op when the repeat count already agrees', () => {
    expect(
      planProgressPush(local({ timesRead: 3 }), tracked(), 'volumes', 'read_count')
    ).toBeNull();
  });

  it('never touches progress or status', () => {
    const plan = planProgressPush(
      local({ passProgress: 9, passComplete: true, timesRead: 5 }),
      tracked(),
      'volumes',
      'read_count'
    )!;
    expect(plan).toEqual({ repeat: 4 });
  });

  it('counts a missing remote entry as repeat 0', () => {
    expect(planProgressPush(local({ timesRead: 2 }), null, 'volumes', 'read_count')).toEqual({
      repeat: 1
    });
    expect(planProgressPush(local({ timesRead: 1 }), null, 'volumes', 'read_count')).toBeNull();
  });
});
