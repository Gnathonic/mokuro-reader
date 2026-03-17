export function getCurrentPeriodStart(
  mode: 'daily' | 'weekly',
  resetHour: number,
  resetDay?: number
): number {
  const now = new Date();

  if (mode === 'daily') {
    const todayReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      resetHour,
      0,
      0,
      0
    );

    if (now < todayReset) {
      const yesterdayReset = new Date(todayReset);
      yesterdayReset.setDate(yesterdayReset.getDate() - 1);
      return yesterdayReset.getTime();
    }

    return todayReset.getTime();
  }

  const targetDay = resetDay ?? 1;
  const currentDay = now.getDay();
  const daysSinceReset = (currentDay - targetDay + 7) % 7;

  const thisWeekReset = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysSinceReset,
    resetHour,
    0,
    0,
    0
  );

  if (now < thisWeekReset) {
    const lastWeekReset = new Date(thisWeekReset);
    lastWeekReset.setDate(lastWeekReset.getDate() - 7);
    return lastWeekReset.getTime();
  }

  return thisWeekReset.getTime();
}

export function getNextResetTime(
  mode: 'daily' | 'weekly',
  resetHour: number,
  resetDay?: number
): number {
  const now = new Date();

  if (mode === 'daily') {
    const todayReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      resetHour,
      0,
      0,
      0
    );

    if (now >= todayReset) {
      const tomorrowReset = new Date(todayReset);
      tomorrowReset.setDate(tomorrowReset.getDate() + 1);
      return tomorrowReset.getTime();
    }

    return todayReset.getTime();
  }

  const targetDay = resetDay ?? 1;
  const currentDay = now.getDay();
  const daysUntilReset = (targetDay - currentDay + 7) % 7;

  const thisWeekReset = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysUntilReset,
    resetHour,
    0,
    0,
    0
  );

  if (daysUntilReset === 0 && now >= thisWeekReset) {
    const nextWeekReset = new Date(thisWeekReset);
    nextWeekReset.setDate(nextWeekReset.getDate() + 7);
    return nextWeekReset.getTime();
  }

  return thisWeekReset.getTime();
}

export function formatRelativeResetTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = timestamp - now;

  if (diffMs <= 0) return 'now';

  const totalMinutes = Math.floor(diffMs / (1000 * 60));
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    if (hours > 0) {
      return `${days}d ${hours}h`;
    }
    return `${days}d`;
  }

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${hours}h`;
  }

  return `${minutes}m`;
}

export function calculatePeriodPageTargetTotal(
  remainingPages: number,
  deadline: string | null,
  mode: 'daily' | 'weekly',
  pagesReadInCurrentPeriod: number,
  periodStartTimestamp: number
): number | null {
  if (!deadline || remainingPages <= 0) return null;

  const pagesStillNeeded = Math.max(0, remainingPages);
  const periodStart = new Date(periodStartTimestamp);
  const deadlineParts = deadline.split('-').map(Number);
  const deadlineInclusiveEnd = new Date(
    deadlineParts[0],
    deadlineParts[1] - 1,
    deadlineParts[2] + 1
  );

  const msPerPeriod = mode === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const msUntilDeadlineInclusive = deadlineInclusiveEnd.getTime() - periodStart.getTime();
  const periodsRemainingIncludingCurrent = Math.max(
    1,
    Math.ceil(msUntilDeadlineInclusive / msPerPeriod)
  );

  return Math.ceil(
    (pagesReadInCurrentPeriod + pagesStillNeeded) / periodsRemainingIncludingCurrent
  );
}
