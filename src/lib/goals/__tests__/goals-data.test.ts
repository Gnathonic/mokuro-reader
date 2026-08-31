import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { get } from 'svelte/store';
import {
  createCustomGoal,
  customGoals,
  ensureCurrentYearTarget,
  goalsWithTrash,
  removeCustomGoal,
  rollForwardStaleSelection,
  setActiveGoalSelection,
  setGoalSections,
  setGoalTarget,
  updateCustomGoal
} from '../goals-data';
import { buildGoalKey } from '../goals-file';
import { getCurrentPeriodKey } from '../periods';
import { setGoalSnapshots } from '../snapshots-store';

const EPOCH = new Date(0).toISOString();

beforeEach(() => {
  setGoalSections({}, {});
  setGoalSnapshots({});
  setActiveGoalSelection({ goalType: 'year', periodKey: getCurrentPeriodKey('year') });
});

describe('ensureCurrentYearTarget', () => {
  it('stamps the synthetic default at the epoch so it loses to any real edit', () => {
    // Stamped `now`, this placeholder out-ranked the 100-volume goal the user
    // actually set on another device last month and silently replaced it
    // everywhere — reachable whenever the tracker is opened before the first
    // goals sync lands, which happens on every expired-token boot.
    ensureCurrentYearTarget();

    const key = buildGoalKey('year', getCurrentPeriodKey('year'));
    const minted = get(goalsWithTrash).targets[key];
    expect(minted.targetVolumes).toBe(52);
    expect(minted.lastUpdated).toBe(EPOCH);
    expect(minted.createdAt).toBe(EPOCH);
  });

  it('leaves an existing target alone, and does not resurrect a deleted one', () => {
    const key = buildGoalKey('year', getCurrentPeriodKey('year'));

    setGoalTarget('year', getCurrentPeriodKey('year'), 100);
    ensureCurrentYearTarget();
    expect(get(goalsWithTrash).targets[key].targetVolumes).toBe(100);

    setGoalSections(
      { [key]: { ...get(goalsWithTrash).targets[key], deletedOn: new Date().toISOString() } },
      {}
    );
    ensureCurrentYearTarget();
    expect(get(goalsWithTrash).targets[key].deletedOn).toBeTruthy();
  });
});

describe('rollForwardStaleSelection', () => {
  it('moves a selection carried over from a period that has since ended', () => {
    // Currently Reading and Future Reads are both gated on the goal not being
    // closed, so a stale selection blanked the page with no explanation —
    // every returning user hit it on 1 January. This is the shape localStorage
    // holds for a selection that WAS current when it was chosen: not pinned.
    goalsWithTrash.update((state) => ({
      ...state,
      activeSelection: { goalType: 'year', periodKey: '2020' },
      selectionPinned: false
    }));

    rollForwardStaleSelection(new Date(2026, 5, 1));

    expect(get(goalsWithTrash).activeSelection).toEqual({
      goalType: 'year',
      periodKey: getCurrentPeriodKey('year')
    });
  });

  it('never moves a period the user deliberately picked from the dropdown', () => {
    // The dropdown offers past periods on purpose. Rolling forward over one
    // snatched the page back to the present the moment the user alt-tabbed
    // away and returned, making a closed period impossible to review.
    setActiveGoalSelection({ goalType: 'year', periodKey: '2020' });
    rollForwardStaleSelection(new Date(2026, 5, 1));

    expect(get(goalsWithTrash).activeSelection).toEqual({
      goalType: 'year',
      periodKey: '2020'
    });
  });

  it('still rolls a selection that was current when it was set', () => {
    // A tab left open across New Year: the selection was not pinned, so it
    // moves rather than blanking the page.
    setActiveGoalSelection({ goalType: 'year', periodKey: getCurrentPeriodKey('year') });
    // Simulate the period having ended by pretending "now" is far in the future.
    const key = getCurrentPeriodKey('year');
    rollForwardStaleSelection(new Date(Number(key) + 5, 0, 2));

    expect(get(goalsWithTrash).selectionPinned).toBe(false);
  });

  it('clears the pin when a deleted custom goal drops the selection to this year', () => {
    // A custom goal always pins. Falling back to the current year is not a
    // deliberate look at the past, so leaving the pin on would stop the
    // selection rolling forward when this year ends — blanking the page.
    expect(
      createCustomGoal({
        name: 'Sprint',
        startDate: '2026-06-01',
        endDate: '2026-08-31',
        targetVolumes: 5,
        enabled: true
      })
    ).toBeNull();
    const goal = get(customGoals)[0];
    setActiveGoalSelection({ goalType: 'custom', customId: goal.id });
    expect(get(goalsWithTrash).selectionPinned).toBe(true);

    removeCustomGoal(goal.id);

    expect(get(goalsWithTrash).activeSelection).toEqual({
      goalType: 'year',
      periodKey: getCurrentPeriodKey('year')
    });
    expect(get(goalsWithTrash).selectionPinned).toBe(false);
  });

  it('leaves a live period and a custom goal alone', () => {
    const live = { goalType: 'year', periodKey: getCurrentPeriodKey('year') } as const;
    setActiveGoalSelection(live);
    rollForwardStaleSelection();
    expect(get(goalsWithTrash).activeSelection).toEqual(live);

    const custom = { goalType: 'custom', customId: 'abc' } as const;
    setActiveGoalSelection(custom);
    rollForwardStaleSelection();
    expect(get(goalsWithTrash).activeSelection).toEqual(custom);
  });
});

describe('custom goal validation reports why it refused', () => {
  const valid = {
    name: 'Summer sprint',
    startDate: '2026-06-01',
    endDate: '2026-08-31',
    targetVolumes: 12,
    enabled: true
  };

  it('accepts a valid goal', () => {
    expect(createCustomGoal(valid)).toBeNull();
    expect(get(customGoals)).toHaveLength(1);
  });

  it('names the failing constraint instead of silently discarding the entry', () => {
    // The caller cleared and closed the form unconditionally, so transposing
    // the dates threw away everything the user had typed with no message.
    expect(createCustomGoal({ ...valid, startDate: '2026-08-01', endDate: '2026-07-01' })).toBe(
      'range'
    );
    expect(createCustomGoal({ ...valid, targetVolumes: 12.5 })).toBe('target');
    expect(createCustomGoal({ ...valid, targetVolumes: 0 })).toBe('target');
    expect(createCustomGoal({ ...valid, name: '   ' })).toBe('name');
    expect(get(customGoals)).toHaveLength(0);
  });

  it('refuses a date move on a snapshotted goal, and says so', () => {
    expect(createCustomGoal(valid)).toBeNull();
    const goal = get(customGoals)[0];

    setGoalSnapshots({
      [`custom:${goal.id}`]: {
        goalType: 'custom',
        periodKey: goal.id,
        startDate: goal.startDate,
        endDate: goal.endDate,
        closedAt: '2026-09-01T00:00:00.000Z',
        completed: {},
        partialProgress: {},
        lastUpdated: '2026-09-01T00:00:00.000Z'
      }
    });

    // Moving the range would make the frozen number describe a period it was
    // never computed over.
    expect(updateCustomGoal({ ...goal, endDate: '2026-09-30' })).toBe('locked');
    // Everything else about it is still editable.
    expect(updateCustomGoal({ ...goal, targetVolumes: 20 })).toBeNull();
    expect(get(customGoals)[0].targetVolumes).toBe(20);
  });

  it('reports a missing goal on the edit path rather than doing nothing', () => {
    expect(updateCustomGoal({ ...valid, id: 'nope', createdAt: '2026-06-01T00:00:00.000Z' })).toBe(
      'missing'
    );
  });
});

describe('isCustomGoalDateRangeLocked', () => {
  it('does not lock a goal merely because its end date is past', async () => {
    // A typo'd year created an already-closed goal that was date-locked the
    // instant it existed, so the typo could never be corrected — only deleted.
    const { isCustomGoalDateRangeLocked } = await import('../snapshots-store');
    expect(
      isCustomGoalDateRangeLocked({ id: 'g1', startDate: '2020-01-01', endDate: '2020-12-31' })
    ).toBe(false);
  });

  it('locks once a snapshot has frozen a number over that range', async () => {
    const { isCustomGoalDateRangeLocked } = await import('../snapshots-store');
    setGoalSnapshots({
      'custom:g1': {
        goalType: 'custom',
        periodKey: 'g1',
        startDate: '2020-01-01',
        endDate: '2020-12-31',
        closedAt: '2021-01-01T00:00:00.000Z',
        completed: {},
        partialProgress: {},
        lastUpdated: '2021-01-01T00:00:00.000Z'
      }
    });
    expect(
      isCustomGoalDateRangeLocked({ id: 'g1', startDate: '2020-01-01', endDate: '2020-12-31' })
    ).toBe(true);
  });
});
