import { browser } from '$app/environment';
import { derived, writable } from 'svelte/store';
import { generateUUID } from '$lib/util/uuid';
import { buildYearKey } from './date-utils';
import { getCurrentPeriodKey, hasValidCustomGoalDateRange } from './periods';
import { isCustomGoalDateRangeLocked } from './snapshots';
import type { CustomGoal, GoalSelection, GoalsData, GoalType } from './types';

const currentYear = new Date().getFullYear();

const defaultGoalsData: GoalsData = {
  targets: [
    {
      goalType: 'year',
      periodKey: buildYearKey(currentYear),
      targetVolumes: 52,
      createdAt: new Date().toISOString()
    }
  ],
  customGoals: [],
  activeSelection: { goalType: 'year', periodKey: buildYearKey(currentYear) }
};

function loadGoalsData(): GoalsData {
  if (!browser) return defaultGoalsData;

  const stored = window.localStorage.getItem('goalsData');
  if (!stored) return defaultGoalsData;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return defaultGoalsData;

    const data = parsed as Partial<GoalsData>;
    return {
      targets: data.targets ?? defaultGoalsData.targets,
      customGoals: data.customGoals ?? defaultGoalsData.customGoals,
      activeSelection: data.activeSelection ?? defaultGoalsData.activeSelection
    };
  } catch {
    return defaultGoalsData;
  }
}

export const _goalsData = writable<GoalsData>(loadGoalsData());

_goalsData.subscribe((data) => {
  if (browser) {
    window.localStorage.setItem('goalsData', JSON.stringify(data));
  }
});

export const goalsData = _goalsData;
export const goalTargets = derived(goalsData, ($data) => $data.targets);
export const customGoals = derived(goalsData, ($data) => $data.customGoals);
export const activeGoalSelection = derived(goalsData, ($data) => $data.activeSelection);

export function setGoalTarget(
  goalType: Exclude<GoalType, 'custom'>,
  periodKey: string,
  targetVolumes: number
) {
  _goalsData.update((data) => {
    const existingIndex = data.targets.findIndex(
      (goal) => goal.goalType === goalType && goal.periodKey === periodKey
    );

    const updatedTargets = [...data.targets];
    if (existingIndex >= 0) {
      updatedTargets[existingIndex] = {
        ...updatedTargets[existingIndex],
        targetVolumes
      };
    } else {
      updatedTargets.push({
        goalType,
        periodKey,
        targetVolumes,
        createdAt: new Date().toISOString()
      });
    }

    return { ...data, targets: updatedTargets };
  });
}

export function removeGoalTarget(goalType: Exclude<GoalType, 'custom'>, periodKey: string) {
  _goalsData.update((data) => {
    return {
      ...data,
      targets: data.targets.filter(
        (goal) => !(goal.goalType === goalType && goal.periodKey === periodKey)
      )
    };
  });
}

export function setActiveGoalSelection(selection: GoalSelection) {
  _goalsData.update((data) => ({ ...data, activeSelection: selection }));
}

export function createCustomGoal(goal: Omit<CustomGoal, 'id' | 'createdAt'>) {
  if (!hasValidCustomGoalDateRange(goal.startDate, goal.endDate)) return;

  _goalsData.update((data) => {
    const id = generateUUID();
    const newGoal: CustomGoal = {
      ...goal,
      id,
      createdAt: new Date().toISOString()
    };
    return {
      ...data,
      customGoals: [...data.customGoals, newGoal],
      activeSelection: { goalType: 'custom', customId: id }
    };
  });
}

export function updateCustomGoal(updatedGoal: CustomGoal) {
  if (!hasValidCustomGoalDateRange(updatedGoal.startDate, updatedGoal.endDate)) return;

  _goalsData.update((data) => ({
    ...data,
    customGoals: data.customGoals.map((goal) => {
      if (goal.id !== updatedGoal.id) return goal;

      if (!isCustomGoalDateRangeLocked(goal)) {
        return {
          ...goal,
          ...updatedGoal,
          id: goal.id,
          createdAt: goal.createdAt
        };
      }

      return {
        ...goal,
        ...updatedGoal,
        id: goal.id,
        createdAt: goal.createdAt,
        startDate: goal.startDate,
        endDate: goal.endDate
      };
    })
  }));
}

export function removeCustomGoal(customId: string) {
  _goalsData.update((data) => {
    const nextSelection: GoalSelection =
      data.activeSelection.goalType === 'custom' && data.activeSelection.customId === customId
        ? { goalType: 'year', periodKey: getCurrentPeriodKey('year') }
        : data.activeSelection;

    return {
      ...data,
      customGoals: data.customGoals.filter((goal) => goal.id !== customId),
      activeSelection: nextSelection
    };
  });
}
