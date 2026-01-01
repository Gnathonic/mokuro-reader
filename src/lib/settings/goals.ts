import { browser } from '$app/environment';
import { writable, derived, get } from 'svelte/store';
import { volumes, type VolumeData } from './volume-data';
import { volumes as catalogVolumes } from '$lib/catalog';

// ================================
// TYPES
// ================================

export type AnnualGoal = {
  year: number;
  targetVolumes: number;
};

export type VolumeDeadline = {
  volumeId: string;
  deadline: string; // ISO date string (YYYY-MM-DD)
};

export type GoalSettings = {
  annualGoals: AnnualGoal[];
  volumeDeadlines: Record<string, string>; // volumeId -> deadline (YYYY-MM-DD)
};

// ================================
// DATE UTILITIES
// ================================

export const dateUtils = {
  /**
   * Calculate days remaining from startDate until endDate (inclusive on both ends)
   * Example: Jan 5 to Jan 8 = 4 days (5th, 6th, 7th, 8th)
   */
  calculateDaysRemaining: (endDate: string | Date, startDate: Date = new Date()): number => {
    let end: Date;
    if (endDate instanceof Date) {
      end = endDate;
    } else {
      // Parse YYYY-MM-DD as local date, not UTC
      const [year, month, day] = endDate.split('-').map(Number);
      end = new Date(year, month - 1, day);
    }
    if (isNaN(end.getTime())) return 0;

    // Set start to midnight of start date, end to midnight AFTER the deadline (end of deadline day)
    const endMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    const startMidnight = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate()
    );

    const diffInMs = endMidnight.getTime() - startMidnight.getTime();
    const diffInDays = diffInMs / (1000 * 60 * 60 * 24);

    return Math.max(0, Math.round(diffInDays));
  },

  /**
   * Get the number of days into the current year (1-indexed, so Jan 1 = 1)
   */
  daysIntoYear: (date: Date = new Date()): number => {
    const startOfYear = new Date(date.getFullYear(), 0, 1); // January 1st
    const dateMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.floor((dateMidnight.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  },

  /**
   * Get the total number of days in a year
   */
  daysInYear: (date: Date = new Date()): number => {
    const year = date.getFullYear();
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  },

  /**
   * Get the end of year date string (December 31st)
   */
  endOfYear: (year: number = new Date().getFullYear()): string => {
    return `${year}-12-31`;
  },

  /**
   * Format date as YYYY-MM-DD (using local timezone)
   */
  formatDate: (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
};

// ================================
// DEFAULT SETTINGS
// ================================

const currentYear = new Date().getFullYear();

const defaultSettings: GoalSettings = {
  annualGoals: [
    {
      year: currentYear,
      targetVolumes: 52 // Default: 1 volume per week
    }
  ],
  volumeDeadlines: {}
};

// ================================
// STORE INITIALIZATION
// ================================

function loadGoalSettings(): GoalSettings {
  if (!browser) return defaultSettings;

  const stored = window.localStorage.getItem('goalSettings');
  if (!stored) return defaultSettings;

  try {
    const parsed = JSON.parse(stored);
    return {
      annualGoals: parsed.annualGoals || defaultSettings.annualGoals,
      volumeDeadlines: parsed.volumeDeadlines || defaultSettings.volumeDeadlines
    };
  } catch {
    return defaultSettings;
  }
}

const _goalSettings = writable<GoalSettings>(loadGoalSettings());

// Persist to localStorage
_goalSettings.subscribe((settings) => {
  if (browser) {
    window.localStorage.setItem('goalSettings', JSON.stringify(settings));
  }
});

export const goalSettings = _goalSettings;

// ================================
// ANNUAL GOAL FUNCTIONS
// ================================

/**
 * Get the annual goal for a specific year
 */
export function getAnnualGoal(year: number = new Date().getFullYear()): number {
  const settings = get(_goalSettings);
  const goal = settings.annualGoals.find((g) => g.year === year);
  return goal?.targetVolumes ?? 52;
}

/**
 * Set the annual goal for a specific year
 */
export function setAnnualGoal(targetVolumes: number, year: number = new Date().getFullYear()) {
  _goalSettings.update((settings) => {
    const existingIndex = settings.annualGoals.findIndex((g) => g.year === year);

    const updatedGoals = [...settings.annualGoals];
    if (existingIndex >= 0) {
      updatedGoals[existingIndex] = { ...updatedGoals[existingIndex], targetVolumes };
    } else {
      updatedGoals.push({ year, targetVolumes });
    }

    return { ...settings, annualGoals: updatedGoals };
  });
}

// ================================
// VOLUME DEADLINE FUNCTIONS
// ================================

/**
 * Get the deadline for a specific volume
 */
export function getVolumeDeadline(volumeId: string): string | null {
  const settings = get(_goalSettings);
  return settings.volumeDeadlines[volumeId] || null;
}

/**
 * Set a deadline for a specific volume
 */
export function setVolumeDeadline(volumeId: string, deadline: string) {
  _goalSettings.update((settings) => {
    return {
      ...settings,
      volumeDeadlines: {
        ...settings.volumeDeadlines,
        [volumeId]: deadline
      }
    };
  });
}

/**
 * Remove the deadline for a specific volume
 */
export function removeVolumeDeadline(volumeId: string) {
  _goalSettings.update((settings) => {
    const { [volumeId]: _, ...rest } = settings.volumeDeadlines;
    return {
      ...settings,
      volumeDeadlines: rest
    };
  });
}

/**
 * Calculate pages per day needed to meet a deadline
 */
export function calculatePagesPerDay(
  remainingPages: number,
  deadline: string | null
): number | null {
  if (!deadline || remainingPages <= 0) return null;

  const daysRemaining = dateUtils.calculateDaysRemaining(deadline);
  if (daysRemaining <= 0) return remainingPages; // All pages today!

  return Math.ceil(remainingPages / daysRemaining);
}

// ================================
// DERIVED STORES
// ================================

/**
 * Derived store with deadline info for each volume
 */
export const volumeDeadlines = derived(goalSettings, ($settings) => {
  return $settings.volumeDeadlines;
});

/**
 * Derived store for current year's annual goal
 */
export const currentAnnualGoal = derived(goalSettings, ($settings) => {
  const year = new Date().getFullYear();
  const goal = $settings.annualGoals.find((g) => g.year === year);
  return goal?.targetVolumes ?? 52;
});

export type AnnualGoalProgress = {
  targetVolumes: number;
  completedVolumes: number;
  inProgressVolumes: number;
  totalProgress: number; // Completed + partial progress from in-progress volumes
  progressPercent: number;
  expectedProgressPercent: number;
  status: 'ahead' | 'on-track' | 'behind' | 'far-behind';
  pagesPerDayForGoal: number;
  daysRemaining: number;
};

/**
 * Derived store that calculates annual goal progress
 */
export const annualGoalProgress = derived(
  [goalSettings, volumes, catalogVolumes],
  ([$settings, $volumes, $catalogVolumes]): AnnualGoalProgress => {
    const year = new Date().getFullYear();
    const today = new Date();
    const goal = $settings.annualGoals.find((g: AnnualGoal) => g.year === year);
    const targetVolumes = goal?.targetVolumes ?? 52;

    let completedVolumes = 0;
    let inProgressVolumes = 0;
    let totalPartialProgress = 0;
    let totalRemainingPages = 0;

    if ($volumes) {
      Object.entries($volumes).forEach(([volumeId, volumeData]) => {
        const catalogVolume = $catalogVolumes[volumeId];
        const totalPages = catalogVolume?.page_count ?? 0;
        const currentPage = (volumeData as VolumeData).progress ?? 0;

        if ((volumeData as VolumeData).completed || (totalPages > 0 && currentPage >= totalPages)) {
          completedVolumes++;
        } else if (currentPage > 1 && totalPages > 0) {
          // In progress (page 1 counts as not started)
          inProgressVolumes++;
          totalPartialProgress += currentPage / totalPages;
          totalRemainingPages += totalPages - currentPage;
        }
      });
    }

    const totalProgress = completedVolumes + totalPartialProgress;
    const progressPercent = targetVolumes > 0 ? (totalProgress / targetVolumes) * 100 : 0;

    const daysIntoYear = dateUtils.daysIntoYear(today);
    const totalDays = dateUtils.daysInYear(today);
    const expectedProgressPercent = (daysIntoYear / totalDays) * 100;

    const daysRemaining = dateUtils.calculateDaysRemaining(dateUtils.endOfYear(year));

    // Calculate pages per day needed to hit goal
    // Remaining volumes needed = targetVolumes - completedVolumes - partial progress
    const remainingVolumeEquivalent = Math.max(0, targetVolumes - totalProgress);
    // Estimate average pages per volume (rough estimate)
    const avgPagesPerVolume =
      totalRemainingPages > 0 && inProgressVolumes > 0
        ? totalRemainingPages / inProgressVolumes
        : 200; // Default estimate

    const estimatedRemainingPages = remainingVolumeEquivalent * avgPagesPerVolume;
    const pagesPerDayForGoal =
      daysRemaining > 0 ? Math.ceil(estimatedRemainingPages / daysRemaining) : 0;

    // Determine status based on how close we are to expected progress
    const progressRatio =
      expectedProgressPercent > 0
        ? progressPercent / expectedProgressPercent
        : progressPercent > 0
          ? 2
          : 1; // If early in year, any progress is "ahead"

    let status: 'ahead' | 'on-track' | 'behind' | 'far-behind';
    if (progressRatio >= 1.1) {
      status = 'ahead';
    } else if (progressRatio >= 0.9) {
      status = 'on-track';
    } else if (progressRatio >= 0.5) {
      status = 'behind';
    } else {
      status = 'far-behind';
    }

    return {
      targetVolumes,
      completedVolumes,
      inProgressVolumes,
      totalProgress,
      progressPercent,
      expectedProgressPercent,
      status,
      pagesPerDayForGoal,
      daysRemaining
    };
  }
);
