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
});
