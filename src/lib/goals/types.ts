export type GoalType = 'year' | 'season' | 'month' | 'today' | 'custom';

export type GoalTarget = {
  goalType: Exclude<GoalType, 'custom'>;
  periodKey: string;
  targetVolumes: number;
  createdAt: string;
};

export type CustomGoal = {
  id: string;
  name: string;
  targetVolumes: number;
  startDate: string;
  endDate: string;
  enabled: boolean;
  createdAt: string;
};

export type GoalSelection =
  | { goalType: Exclude<GoalType, 'custom'>; periodKey: string }
  | { goalType: 'custom'; customId: string };

export type GoalPeriod = {
  goalType: GoalType;
  periodKey: string;
  label: string;
  start: Date;
  end: Date;
};

export type GoalSnapshot = {
  goalType: GoalType;
  periodKey: string;
  startDate: string;
  endDate: string;
  closedAt: string;
  completed: Record<string, string>;
  partialProgress: Record<string, number>;
};

export type VolumeDeadline = {
  volumeId: string;
  deadline: string;
};

export type GoalSettings = {
  volumeDeadlines: Record<string, string>;
};

export type GoalsData = {
  targets: GoalTarget[];
  customGoals: CustomGoal[];
  activeSelection: GoalSelection;
};

export type CompletedAtMap = Record<string, string>;

export type GoalProgress = {
  title: string;
  targetVolumes: number;
  completedVolumes: number;
  inProgressVolumes: number;
  totalProgress: number;
  progressPercent: number;
  expectedProgressPercent: number;
  status: 'ahead' | 'on-track' | 'behind' | 'far-behind';
  pagesPerDayForGoal: number;
  daysRemaining: number;
  periodLabel: string;
  isClosed: boolean;
};
