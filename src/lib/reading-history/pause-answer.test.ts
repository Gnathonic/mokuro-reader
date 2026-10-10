import { describe, expect, it, vi } from 'vitest';
import { answerPause } from './pause-answer';
import type { LivePause } from './pause-watch';

const MIN = 60_000;
/** ms per character. */
const PACE = 300;
const AUTO = { k: 3, overrideMs: null };

function effects() {
  return { split: vi.fn(), widenIdleK: vi.fn(), setPauseDefault: vi.fn(), notify: vi.fn() };
}

/** 400 chars at 300 ms/char: 2 min expected, so a 6 min cap at k = 3. */
const pause: LivePause = { volume: 'v1', since: 0, chars: 400, cap: 6 * MIN, typical: 2 * MIN };

describe('answerPause', () => {
  it('splits the view at the answer, with the answer, and nothing else', () => {
    const fx = effects();
    answerPause(pause, 'typical', { stillReading: false, always: false }, PACE, AUTO, fx, 7 * MIN);
    expect(fx.split).toHaveBeenCalledWith(7 * MIN, 'typical');
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.setPauseDefault).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Still reading" widens k to fit this view and says the new cutoff', () => {
    const fx = effects();
    // 8 min × 1.5 headroom / 2 min expected = 6 → k 6 → cap 6 × 2 min = 12 min.
    answerPause(pause, 'full', { stillReading: true, always: false }, PACE, AUTO, fx, 8 * MIN);
    expect(fx.split).toHaveBeenCalledWith(8 * MIN, 'full');
    expect(fx.widenIdleK).toHaveBeenCalledWith(6);
    expect(fx.notify).toHaveBeenCalledWith('Cutoff widened to ~12 min for pages like this');
  });

  it('"Count all" from the away copy never widens', () => {
    const fx = effects();
    answerPause(pause, 'full', { stillReading: false, always: false }, PACE, AUTO, fx, 30 * MIN);
    expect(fx.split).toHaveBeenCalledWith(30 * MIN, 'full');
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Still reading" under a manual cutoff leaves it and points at Settings', () => {
    const fx = effects();
    const manual = { k: 3, overrideMs: 5 * MIN };
    answerPause(pause, 'full', { stillReading: true, always: false }, PACE, manual, fx, 8 * MIN);
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).toHaveBeenCalledWith('Manual cutoff is 5 min — change it in Settings');
  });

  it('"Still reading" before there is a pace changes nothing (the cap is fixed)', () => {
    const fx = effects();
    answerPause(pause, 'full', { stillReading: true, always: false }, null, AUTO, fx, 8 * MIN);
    expect(fx.split).toHaveBeenCalledWith(8 * MIN, 'full');
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Still reading" on a page held at the floor leaves k alone (O4)', () => {
    const fx = effects();
    // 10 chars: 3 s expected; k = 20 would still be 60 s, the floor.
    const art: LivePause = { volume: 'v1', since: 0, chars: 10, cap: MIN, typical: MIN };
    answerPause(art, 'full', { stillReading: true, always: false }, PACE, AUTO, fx, 90_000);
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Always do this" makes the answer the standing default', () => {
    const fx = effects();
    answerPause(pause, 'none', { stillReading: false, always: true }, PACE, AUTO, fx, 7 * MIN);
    expect(fx.setPauseDefault).toHaveBeenCalledWith('none');
  });
});
