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

  daysIntoYear: (date: Date = new Date()): number => {
    const startOfYear = new Date(date.getFullYear(), 0, 1);
    const dateMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.floor((dateMidnight.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  },

  daysInYear: (date: Date = new Date()): number => {
    const year = date.getFullYear();
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  },

  endOfYear: (year: number = new Date().getFullYear()): string => {
    return `${year}-12-31`;
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

export function parseSeasonKey(periodKey: string): { year: number; seasonIndex: number } | null {
  const [yearPart, seasonPart] = periodKey.split('-');
  const year = Number(yearPart);
  const seasonIndex = dateUtils.seasonNames.indexOf(seasonPart as (typeof seasonNames)[number]);
  if (!Number.isFinite(year) || seasonIndex < 0) return null;
  return { year, seasonIndex };
}

export function parseMonthKey(periodKey: string): { year: number; monthIndex: number } | null {
  const [yearPart, monthPart] = periodKey.split('-');
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

export function parseYearKey(periodKey: string): number | null {
  const year = Number(periodKey);
  return Number.isFinite(year) ? year : null;
}
