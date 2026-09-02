export type {
  CompletedAtMap,
  CustomGoal,
  GoalPeriod,
  GoalProgress,
  GoalSelection,
  GoalSettings,
  GoalSnapshot,
  GoalsData,
  GoalTarget,
  GoalType,
  VolumeDeadline
} from './types';

export {
  buildMonthKey,
  buildSeasonKey,
  buildTodayKey,
  buildYearKey,
  dateUtils,
  parseMonthKey,
  parseSeasonKey,
  parseYearKey
} from './date-utils';

export {
  getCustomPeriod,
  getCurrentPeriodKey,
  getPeriodForSelection,
  getRecentPeriods,
  hasValidCustomGoalDateRange,
  isCustomGoalClosed,
  isDateWithinRange,
  parseLocalDateString
} from './periods';

export {
  calculatePeriodPageTargetTotal,
  formatRelativeResetTime,
  getCurrentPeriodStart,
  getNextResetTime
} from './progress-targets';

export {
  deadlinesWithTrash,
  goalSettings,
  getVolumeDeadline,
  pruneDeadlinesForDeletedVolumes,
  removeVolumeDeadline,
  setVolumeDeadline,
  setVolumeDeadlineEntries,
  volumeDeadlines
} from './goal-settings';

export {
  activeGoalSelection,
  createCustomGoal,
  customGoals,
  ensureCurrentYearTarget,
  goalTargets,
  goalsWithTrash,
  removeCustomGoal,
  setGoalSections,
  removeGoalTarget,
  setActiveGoalSelection,
  setGoalTarget,
  updateCustomGoal
} from './goals-data';

export { completedAtMap, completionEventsFor } from './completed-at';

export { backfillCompletedAt } from './completed-at-backfill';

export { createSnapshotForPeriod, finalizeGoalSnapshot } from './snapshots';

export {
  buildGoalSnapshotKey,
  goalSnapshots,
  isCustomGoalDateRangeLocked,
  setGoalSnapshots
} from './snapshots-store';

export { finalizeClosedGoalSnapshots, initGoalsLifecycle } from './lifecycle';

export {
  GOALS_FILE_NAME,
  composeGoalsFile,
  detectBogusGoalKeys,
  emptySections,
  mergeGoalsSections,
  parseGoalsFile,
  purgeGoalTombstones,
  type GoalsFile,
  type GoalsFileSections
} from './goals-file';

export { activeGoalPeriod, activeGoalProgress, activeGoalSnapshot } from './active-progress';
