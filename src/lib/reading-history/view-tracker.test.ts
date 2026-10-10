import { describe, expect, it } from 'vitest';
import { ViewTracker, type ViewDescriptor } from './view-tracker';
import type { PagePayload, PauseCount } from './types';

function view(first: number, last = first, extra: Partial<ViewDescriptor> = {}): ViewDescriptor {
  return {
    volume: 'vol-1',
    first_page: first,
    last_page: last,
    page_chars: Array.from({ length: last - first + 1 }, () => 50),
    chars_before: (first - 1) * 50,
    layout: first === last ? 'single' : 'double',
    orientation: 'portrait',
    viewport: { w: 400, h: 800 },
    ...extra
  };
}

type Answer = { count: PauseCount; t: number } | null;

function setup() {
  const emitted: { payload: PagePayload; t: number; answer: Answer }[] = [];
  const changes: Array<{ first: number; since: number; answer: PauseCount | null } | null> = [];
  const tracker = new ViewTracker(
    (payload, t, answer) => emitted.push({ payload, t, answer }),
    (open) =>
      changes.push(open && { first: open.view.first_page, since: open.since, answer: open.answer })
  );
  return { tracker, emitted, changes };
}

describe('ViewTracker', () => {
  it('emits the previous view with its dwell when the view changes', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 1000);
    tracker.setView(view(2), 31000);
    expect(emitted).toEqual([
      { payload: { kind: 'page', ...view(1), dwell_ms: 30000 }, t: 1000, answer: null }
    ]);
  });

  it('ignores a re-set of the same view (same volume, pages, layout)', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 1000);
    tracker.setView(view(1, 1, { viewport: { w: 500, h: 900 } }), 2000);
    tracker.setView(view(2), 5000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.dwell_ms).toBe(4000);
  });

  it('closes on null (tab hidden) and reopens the same view as a new event', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(3), 0);
    tracker.setView(null, 10000);
    tracker.setView(view(3), 60000);
    tracker.close(65000);
    expect(emitted.map((e) => [e.t, e.payload.dwell_ms])).toEqual([
      [0, 10000],
      [60000, 5000]
    ]);
  });

  it('treats a layout change on the same pages as a new view', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(4, 4, { layout: 'single' }), 0);
    tracker.setView(view(4, 4, { layout: 'continuous-v' }), 2000);
    expect(emitted).toHaveLength(1);
  });

  it('close with nothing open emits nothing, and close is idempotent', () => {
    const { tracker, emitted } = setup();
    tracker.close(5);
    tracker.setView(view(1), 10);
    tracker.close(20);
    tracker.close(30);
    expect(emitted).toHaveLength(1);
  });

  it('never emits a negative dwell if the clock steps backwards', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 5000);
    tracker.close(4000);
    expect(emitted[0].payload.dwell_ms).toBe(0);
  });
});

describe('ViewTracker onChange', () => {
  it('reports each open view with its start, and null when nothing is open', () => {
    const changes: Array<{ first: number; since: number } | null> = [];
    const tracker = new ViewTracker(
      () => {},
      (open) => changes.push(open && { first: open.view.first_page, since: open.since })
    );
    tracker.setView(view(1), 1000);
    tracker.setView(view(1), 1500); // same view: no change
    tracker.setView(view(2), 2000);
    tracker.setView(null, 3000);
    tracker.close(4000); // already closed: no change
    expect(changes).toEqual([{ first: 1, since: 1000 }, { first: 2, since: 2000 }, null]);
  });
});

describe('ViewTracker answers', () => {
  it('split writes the paused view with the answer and reopens the same view at the answer', () => {
    const { tracker, emitted, changes } = setup();
    tracker.setView(view(1), 1000);
    tracker.split(400_000, 'typical');
    expect(emitted).toEqual([
      {
        payload: { kind: 'page', ...view(1), dwell_ms: 399_000 },
        t: 1000,
        answer: { count: 'typical', t: 400_000 }
      }
    ]);
    expect(changes).toEqual([
      { first: 1, since: 1000, answer: null },
      { first: 1, since: 400_000, answer: null }
    ]);
    // The continuation is the same view: re-setting it is no change, and it
    // ends unanswered with the time since the answer.
    tracker.setView(view(1), 450_000);
    tracker.setView(view(2), 500_000);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual({
      payload: { kind: 'page', ...view(1), dwell_ms: 100_000 },
      t: 400_000,
      answer: null
    });
  });

  it('setAnswer presets the open view: written with its stamp when the view ends', () => {
    const { tracker, emitted, changes } = setup();
    tracker.setView(view(1), 0);
    tracker.setAnswer('full', 300_000);
    expect(emitted).toHaveLength(0);
    expect(changes).toEqual([
      { first: 1, since: 0, answer: null },
      { first: 1, since: 0, answer: 'full' }
    ]);
    tracker.setView(view(2), 900_000);
    expect(emitted[0]).toEqual({
      payload: { kind: 'page', ...view(1), dwell_ms: 900_000 },
      t: 0,
      answer: { count: 'full', t: 300_000 }
    });
  });

  it('clears the answer on the next view', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 0);
    tracker.setAnswer('none', 100_000);
    tracker.setView(view(2), 200_000);
    tracker.close(250_000);
    tracker.setView(view(2), 300_000);
    tracker.setView(null, 310_000);
    expect(emitted.map((e) => e.answer)).toEqual([{ count: 'none', t: 100_000 }, null, null]);
  });

  it('a live answer replaces the preset, and the continuation starts unanswered', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 0);
    tracker.setAnswer('none', 100_000);
    tracker.split(200_000, 'full');
    tracker.close(260_000);
    expect(emitted.map((e) => [e.t, e.payload.dwell_ms, e.answer])).toEqual([
      [0, 200_000, { count: 'full', t: 200_000 }],
      [200_000, 60_000, null]
    ]);
  });

  it('split and setAnswer with no open view do nothing', () => {
    const { tracker, emitted, changes } = setup();
    tracker.split(5, 'none');
    tracker.setAnswer('full', 6);
    expect(emitted).toEqual([]);
    expect(changes).toEqual([]);
    tracker.setView(view(1), 10);
    tracker.close(20);
    tracker.split(30, 'typical');
    tracker.setAnswer('typical', 40);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].answer).toBeNull();
    expect(changes).toEqual([{ first: 1, since: 10, answer: null }, null]);
  });

  it('never emits a negative dwell when splitting on a clock that stepped back', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 5000);
    tracker.split(4000, 'full');
    expect(emitted[0].payload.dwell_ms).toBe(0);
  });

  it('setAnswer(null) withdraws a preset; the view ends unanswered', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 0);
    tracker.setAnswer('none', 100);
    tracker.setAnswer(null, 200);
    tracker.setView(view(2), 900);
    expect(emitted[0].answer).toBeNull();
  });

  it('a withdrawn preset (cap grew past the time so far) is re-applied when the cap is reached again', () => {
    const { tracker, emitted, changes } = setup();
    tracker.setView(view(1), 0);
    tracker.setAnswer('full', 300_000); // standing default preset at the cap
    tracker.setAnswer(null, 320_000); // the cap grew past the time so far: withdrawn
    tracker.setAnswer(null, 330_000); // already withdrawn: no change reported
    tracker.setAnswer('full', 600_000); // the new cap is reached: preset again
    tracker.setView(view(2), 700_000);
    expect(changes).toEqual([
      { first: 1, since: 0, answer: null },
      { first: 1, since: 0, answer: 'full' },
      { first: 1, since: 0, answer: null },
      { first: 1, since: 0, answer: 'full' },
      { first: 2, since: 700_000, answer: null }
    ]);
    expect(emitted).toEqual([
      {
        payload: { kind: 'page', ...view(1), dwell_ms: 700_000 },
        t: 0,
        answer: { count: 'full', t: 600_000 }
      }
    ]);
  });
});
