const seasonNames = ['Winter', 'Spring', 'Summer', 'Autumn'] as const;

export const dateUtils = {
  calculateDaysRemaining: (endDate: string | Date, startDate: Date = new Date()): number => {
    let end: Date;
    if (endDate instanceof Date) {
      end = endDate;
    } else {
      const [year, month, day] = endDate.split('-').map(Number);
      end = new Date(year, month - 1, day);
    }
    if (Number.isNaN(end.getTime())) return 0;

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

  formatDate: (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  startOfDay: (date: Date = new Date()): Date => {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  },

  seasonNames,

  seasonIndex: (date: Date = new Date()): number => {
    return Math.floor(date.getMonth() / 3);
  },

  seasonName: (date: Date = new Date()): (typeof seasonNames)[number] => {
    return seasonNames[dateUtils.seasonIndex(date)];
  },

  seasonRange: (year: number, quarter: number): { start: Date; end: Date } => {
    if (quarter < 0 || quarter > 3) {
      throw new RangeError('Quarter must be 0–3');
    }
    const month = quarter * 3;
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month + 3, 1)
    };
  },

  monthRange: (year: number, monthIndex: number): { start: Date; end: Date } => {
    if (monthIndex < 0 || monthIndex > 11) {
      throw new RangeError('Month index must be 0–11');
    }
    return {
      start: new Date(year, monthIndex, 1),
      end: new Date(year, monthIndex + 1, 1)
    };
  }
};

export function buildSeasonKey(year: number, seasonIndex: number): string {
  const name = dateUtils.seasonNames[seasonIndex] || 'Unknown';
  return `${year}-${name}`;
}

export function buildMonthKey(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

export function buildYearKey(year: number): string {
  return `${year}`;
}

export function buildTodayKey(date: Date = new Date()): string {
  return dateUtils.formatDate(date);
}

/**
 * Period keys are matched WHOLE, never split on '-' and coerced.
 *
 * The four key shapes share a separator, so a loose parser silently accepts
 * another shape's key: `parseMonthKey('2026-Winter')` used to return
 * `monthIndex: NaN` (`Number('Winter')` is NaN, and NaN fails BOTH `< 0` and
 * `> 11`, so the range guard waved it through), and `parseMonthKey('2026-08-30')`
 * read a today key as August. The caller then built a `GoalPeriod` around an
 * Invalid Date and every comparison against it came out false — a goal that
 * silently counted nothing rather than one that failed to load.
 */
const SEASON_KEY_PATTERN = new RegExp(`^(\\d{4})-(${seasonNames.join('|')})$`);
const MONTH_KEY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR_KEY_PATTERN = /^\d{4}$/;

export function parseSeasonKey(periodKey: string): { year: number; seasonIndex: number } | null {
  const match = SEASON_KEY_PATTERN.exec(periodKey);
  if (!match) return null;
  return {
    year: Number(match[1]),
    seasonIndex: seasonNames.indexOf(match[2] as (typeof seasonNames)[number])
  };
}

export function parseMonthKey(periodKey: string): { year: number; monthIndex: number } | null {
  const match = MONTH_KEY_PATTERN.exec(periodKey);
  if (!match) return null;
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

export function parseYearKey(periodKey: string): number | null {
  // `Number('')` and `Number('  ')` are 0, not NaN, so the old `Number.isFinite`
  // guard turned an empty key into the year 0 and a period starting in 1900.
  return YEAR_KEY_PATTERN.test(periodKey) ? Number(periodKey) : null;
}
