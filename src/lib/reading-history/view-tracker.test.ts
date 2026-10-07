import { describe, expect, it } from 'vitest';
import { ViewTracker, type ViewDescriptor } from './view-tracker';
import type { PagePayload } from './types';

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

function setup() {
  const emitted: { payload: PagePayload; t: number }[] = [];
  const tracker = new ViewTracker((payload, t) => emitted.push({ payload, t }));
  return { tracker, emitted };
}

describe('ViewTracker', () => {
  it('emits the previous view with its dwell when the view changes', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 1000);
    tracker.setView(view(2), 31000);
    expect(emitted).toEqual([{ payload: { kind: 'page', ...view(1), dwell_ms: 30000 }, t: 1000 }]);
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
