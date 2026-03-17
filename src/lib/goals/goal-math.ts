import type { PageTurn } from '../settings/volume-data';

export function getExpectedProgressPercent(
  periodStart: Date,
  periodEnd: Date,
  now = new Date()
): number {
  const totalMs = periodEnd.getTime() - periodStart.getTime();
  if (totalMs <= 0) return 0;
  const elapsedMs = Math.min(Math.max(now.getTime() - periodStart.getTime(), 0), totalMs);
  return (elapsedMs / totalMs) * 100;
}

export function getDaysRemainingInPeriod(periodEnd: Date, now = new Date()): number {
  const endMidnight = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), periodEnd.getDate());
  const startMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffInMs = endMidnight.getTime() - startMidnight.getTime();
  return Math.max(0, Math.round(diffInMs / (1000 * 60 * 60 * 24)));
}

export function calculatePartialVolumeProgressInPeriod(
  pageTurns: PageTurn[],
  periodStart: Date,
  periodEnd: Date,
  totalPages: number
): number {
  if (totalPages <= 0 || pageTurns.length === 0) return 0;

  const periodStartTimestamp = periodStart.getTime();
  const periodEndTimestamp = periodEnd.getTime();
  const uniquePagesRead = new Set(
    pageTurns
      .filter(([timestamp]) => timestamp >= periodStartTimestamp && timestamp < periodEndTimestamp)
      .map(([, pageNumber]) => pageNumber)
  ).size;

  if (uniquePagesRead <= 0) return 0;

  return Math.min(uniquePagesRead, totalPages) / totalPages;
}
