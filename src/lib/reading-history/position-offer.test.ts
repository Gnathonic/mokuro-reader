import { describe, expect, it } from 'vitest';
import { planPosition } from './position-offer';
import type { ReadingEvent } from './types';

let seq = 0;
const view = (device: string, t: number, page: number, last = page): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'page',
  volume: 'v',
  first_page: page,
  last_page: last,
  page_chars: [10],
  chars_before: page * 10,
  dwell_ms: 1000,
  layout: 'single',
  orientation: 'portrait',
  viewport: null
});
const restart = (device: string, t: number): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'restart',
  volume: 'v'
});
const answer = (
  t: number,
  through: number,
  a: 'jump' | 'stay' | 'reset' = 'stay'
): ReadingEvent => ({
  device: 'phone',
  seq: ++seq,
  t,
  kind: 'position',
  volume: 'v',
  answer: a,
  through,
  page: 0
});
const run = (device: string, start: number, pages: number[]) =>
  pages.map((p, i) => view(device, start + i * 1000, p));

describe('planPosition', () => {
  it("the stale laptop: offers the phone's final page on every device", () => {
    const events = [...run('phone', 0, [40, 41, 42, 120]), ...run('laptop', 10_000, [40, 41])];
    const plan = planPosition(events, { progress: 41 }, 'laptop');
    expect(plan).toEqual({
      offer: { page: 120, chars: 1210, at: 3000, device: 'phone', ownDevice: false }
    });
    expect(planPosition(events, { progress: 41 }, 'phone').offer).toMatchObject({
      page: 120,
      ownDevice: true
    });
  });

  it('a handoff (the laptop picked up where the phone stopped) offers nothing', () => {
    const events = [...run('phone', 0, [40, 41, 120]), ...run('laptop', 10_000, [120, 121, 122])];
    expect(planPosition(events, { progress: 122 }, 'laptop')).toEqual({});
  });

  it('a laptop the foreground sync corrected (it reached the page later) offers nothing', () => {
    const events = [...run('phone', 0, [119, 120]), ...run('laptop', 10_000, [40, 120, 121])];
    expect(planPosition(events, { progress: 121 }, 'laptop')).toEqual({});
  });

  it('a peek ahead and back offers where the phone stopped, not how far it peeked', () => {
    const events = [...run('phone', 0, [118, 125, 120]), ...run('laptop', 10_000, [40, 41])];
    expect(planPosition(events, { progress: 41 }, 'laptop').offer?.page).toBe(120);
  });

  it('a double-page spread that shows the page counts as reaching it', () => {
    const events = [
      ...run('phone', 0, [120]),
      view('laptop', 10_000, 119, 120),
      view('laptop', 11_000, 121, 122)
    ];
    expect(planPosition(events, { progress: 121 }, 'laptop')).toEqual({});
  });

  it('nothing when the offered page is where the volume already is', () => {
    const events = [...run('phone', 0, [41]), ...run('laptop', 10_000, [40, 41])];
    expect(planPosition(events, { progress: 41 }, 'laptop')).toEqual({});
  });

  it('an answer covers that reading on every device; later reading can be offered again', () => {
    const events = [...run('phone', 0, [120]), ...run('laptop', 10_000, [40, 41])];
    expect(planPosition([...events, answer(20_000, 0)], { progress: 41 }, 'laptop')).toEqual({});
    const later = [
      ...events,
      answer(20_000, 0),
      ...run('phone', 30_000, [130]),
      ...run('laptop', 40_000, [42])
    ];
    expect(planPosition(later, { progress: 42 }, 'laptop').offer?.page).toBe(130);
  });

  it('with several other devices, the most recent final page is offered', () => {
    const events = [
      ...run('phone', 0, [100]),
      ...run('tablet', 5_000, [150]),
      ...run('laptop', 10_000, [40])
    ];
    expect(planPosition(events, { progress: 40 }, 'laptop').offer).toMatchObject({
      page: 150,
      device: 'tablet'
    });
  });

  it('a restart the stale device never saw wins, and its reading is offered', () => {
    const events = [
      ...run('phone', 0, [200]),
      restart('phone', 5_000),
      ...run('laptop', 10_000, [60, 61])
    ];
    expect(planPosition(events, { progress: 61 }, 'laptop')).toEqual({
      reset: { at: 5_000 },
      offer: { page: 61, chars: 620, at: 11_000, device: 'laptop', ownDevice: true }
    });
  });

  it('once the reset is applied, only the offer of the missed reading remains', () => {
    const events = [
      ...run('phone', 0, [200]),
      restart('phone', 5_000),
      ...run('laptop', 10_000, [60, 61]),
      answer(12_000, 5_000, 'reset')
    ];
    expect(planPosition(events, { progress: 0 }, 'phone')).toEqual({
      offer: { page: 61, chars: 620, at: 11_000, device: 'laptop', ownDevice: false }
    });
  });

  it('reading that started over after the restart is not a missed restart', () => {
    const events = [
      ...run('phone', 0, [200]),
      restart('phone', 5_000),
      ...run('laptop', 10_000, [1, 2, 3])
    ];
    expect(planPosition(events, { progress: 3 }, 'laptop')).toEqual({});
  });

  it('a single device never gets an offer', () => {
    expect(planPosition(run('phone', 0, [10, 50, 20]), { progress: 20 }, 'phone')).toEqual({});
  });

  it('legacy (converted) turns never drive offers', () => {
    const legacy = { ...view('legacy:v', 0, 120), device: 'legacy:v' } as ReadingEvent;
    expect(
      planPosition([legacy, ...run('laptop', 10_000, [40])], { progress: 40 }, 'laptop')
    ).toEqual({});
  });
});
