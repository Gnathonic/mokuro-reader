import { describe, expect, it, vi } from 'vitest';
import { answerPause } from './pause-answer';
import type { LivePause } from './pause-watch';

const MIN = 60_000;
/** ms per character. */
const PACE = 300;
const AUTO = { k: 3, overrideMs: null };

function effects() {
  return { split: vi.fn(), widenIdleK: vi.fn(), stopAsking: vi.fn(), notify: vi.fn() };
}

/** 400 chars at 300 ms/char: 2 min expected, so a 6 min cap at k = 3. */
const pause: LivePause = { volume: 'v1', since: 0, chars: 400, cap: 6 * MIN };

describe('answerPause', () => {
  it('"Keep" splits the view unanswered: the time so far counts up to the cutoff', () => {
    const fx = effects();
    answerPause(pause, 'keep', PACE, AUTO, fx, 30 * MIN);
    expect(fx.split).toHaveBeenCalledWith(30 * MIN, null);
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.stopAsking).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Count all" and "Count none" split the view with that answer, and nothing else', () => {
    for (const [answer, count] of [
      ['all', 'full'],
      ['none', 'none']
    ] as const) {
      const fx = effects();
      answerPause(pause, answer, PACE, AUTO, fx, 30 * MIN);
      expect(fx.split).toHaveBeenCalledWith(30 * MIN, count);
      expect(fx.widenIdleK).not.toHaveBeenCalled();
      expect(fx.stopAsking).not.toHaveBeenCalled();
      expect(fx.notify).not.toHaveBeenCalled();
    }
  });

  it('"Don\'t ask again" keeps the cutoff for this page and turns the question off', () => {
    const fx = effects();
    answerPause(pause, 'stop-asking', PACE, AUTO, fx, 7 * MIN);
    expect(fx.split).toHaveBeenCalledWith(7 * MIN, null);
    expect(fx.stopAsking).toHaveBeenCalledOnce();
    expect(fx.notify).toHaveBeenCalledWith(
      'The reader won’t ask again. Turn it back on in Settings → Reading timer.'
    );
  });

  it('"Still reading" counts all of it, widens k to fit this view and says the new cutoff', () => {
    const fx = effects();
    // 8 min × 1.5 headroom / 2 min expected = 6 → k 6 → cap 6 × 2 min = 12 min.
    answerPause(pause, 'still-reading', PACE, AUTO, fx, 8 * MIN);
    expect(fx.split).toHaveBeenCalledWith(8 * MIN, 'full');
    expect(fx.widenIdleK).toHaveBeenCalledWith(6);
    expect(fx.notify).toHaveBeenCalledWith(
      'Pages like this now get about 12 min before the timer stops.'
    );
  });

  it('"Still reading" under a fixed cutoff leaves it and says where to change it', () => {
    const fx = effects();
    const manual = { k: 3, overrideMs: 5 * MIN };
    answerPause(pause, 'still-reading', PACE, manual, fx, 8 * MIN);
    expect(fx.split).toHaveBeenCalledWith(8 * MIN, 'full');
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).toHaveBeenCalledWith(
      'The timer stops after 5 min on every page. Change it in Settings → Reading timer.'
    );
  });

  it('"Still reading" before there is a pace changes nothing (the cap is fixed)', () => {
    const fx = effects();
    answerPause(pause, 'still-reading', null, AUTO, fx, 8 * MIN);
    expect(fx.split).toHaveBeenCalledWith(8 * MIN, 'full');
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Still reading" on a page held at the floor leaves k alone (O4)', () => {
    const fx = effects();
    // 10 chars: 3 s expected; k = 20 would still be 60 s, the floor.
    const art: LivePause = { volume: 'v1', since: 0, chars: 10, cap: MIN };
    answerPause(art, 'still-reading', PACE, AUTO, fx, 90_000);
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });
});
