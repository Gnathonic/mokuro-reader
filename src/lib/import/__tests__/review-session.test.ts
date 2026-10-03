import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptMissingFiles: vi.fn() }));

import {
  appendReviewGroups,
  currentStep,
  decideCurrent,
  reviewSession,
  skipAllRemaining,
  type GroupDecision
} from '../review-session';
import { getImportUiBridge } from '../import-ui';
import type { ReviewGroup } from '../image-only-review';
import { installReviewer } from './helpers/review-bridge';

const group = (series: string): ReviewGroup => ({
  id: `g-${series}`,
  series,
  candidates: [],
  ownUuids: [],
  matches: new Map(),
  existingCount: 0
});
const importIt: GroupDecision = {
  action: 'import',
  naming: { series: 'x', mode: 'cleaned', start: 1, overrides: {} }
};
const step = () => {
  const s = currentStep(get(reviewSession));
  return s && { series: s.group.series, step: s.step, total: s.total };
};

describe('review session (#285)', () => {
  beforeEach(() => reviewSession.set({ pending: [], decided: 0 }));

  it('has no step while nothing is pending', () => {
    expect(step()).toBeNull();
  });

  it('steps through the groups in order, "Series k of n"', () => {
    const onDecision = vi.fn();
    appendReviewGroups([group('A'), group('B')], onDecision);
    expect(step()).toEqual({ series: 'A', step: 1, total: 2 });
    decideCurrent(importIt);
    expect(onDecision).toHaveBeenCalledWith('g-A', importIt);
    expect(step()).toEqual({ series: 'B', step: 2, total: 2 });
  });

  it('closes after the last decision and numbers the next review from 1', () => {
    appendReviewGroups([group('A')], vi.fn());
    decideCurrent({ action: 'skip' });
    expect(step()).toBeNull();
    appendReviewGroups([group('C')], vi.fn());
    expect(step()).toEqual({ series: 'C', step: 1, total: 1 });
  });

  it('a second import appends to the open review instead of replacing it', () => {
    const first = vi.fn();
    const second = vi.fn();
    appendReviewGroups([group('A'), group('B')], first);
    decideCurrent(importIt);
    appendReviewGroups([group('C')], second);
    expect(step()).toEqual({ series: 'B', step: 2, total: 3 });
    decideCurrent({ action: 'skip' });
    decideCurrent(importIt);
    expect(first.mock.calls.map(([id]) => id)).toEqual(['g-A', 'g-B']);
    expect(second).toHaveBeenCalledWith('g-C', importIt);
  });

  it('skip all remaining skips every pending group, in order, as "all", and closes', () => {
    const onDecision = vi.fn();
    appendReviewGroups([group('A'), group('B'), group('C')], onDecision);
    decideCurrent(importIt);
    skipAllRemaining();
    expect(onDecision.mock.calls).toEqual([
      ['g-A', importIt],
      ['g-B', { action: 'skip', all: true }],
      ['g-C', { action: 'skip', all: true }]
    ]);
    expect(step()).toBeNull();
  });

  it('a decision callback that throws neither blocks the others nor the session', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const later = vi.fn();
    appendReviewGroups([group('A')], () => {
      throw new Error('boom');
    });
    appendReviewGroups([group('B')], later);
    skipAllRemaining();
    expect(later).toHaveBeenCalledWith('g-B', { action: 'skip', all: true });
    expect(step()).toBeNull();
    error.mockRestore();
  });

  it('the callback runs after the session moved on, so it can append more', () => {
    appendReviewGroups([group('A')], () => appendReviewGroups([group('Nested')], vi.fn()));
    decideCurrent(importIt);
    expect(step()).toEqual({ series: 'Nested', step: 1, total: 1 });
  });

  it('deciding with nothing pending does nothing', () => {
    expect(() => decideCurrent(importIt)).not.toThrow();
    expect(step()).toBeNull();
  });

  it('the default bridge offers groups to the session', () => {
    const onDecision = vi.fn();
    getImportUiBridge().reviewImageOnly([group('A')], onDecision);
    expect(step()).toEqual({ series: 'A', step: 1, total: 1 });
  });

  it('installReviewer stands in for the dialog and restores the bridge', () => {
    const reviewer = installReviewer();
    const onDecision = vi.fn();
    getImportUiBridge().reviewImageOnly([group('A')], onDecision);
    expect(reviewer.offered.map((g) => g.series)).toEqual(['A']);
    expect(onDecision).toHaveBeenCalledWith('g-A', {
      action: 'import',
      naming: { series: 'A', mode: 'cleaned', start: 1, overrides: {} }
    });
    expect(step()).toBeNull();
    reviewer.restore();
    getImportUiBridge().reviewImageOnly([group('B')], vi.fn());
    expect(step()).toEqual({ series: 'B', step: 1, total: 1 });
  });
});
