/**
 * Merging two LIVE copies of one volume's record, after the newest-wins rule
 * has picked a winner (`mergeVolumePair` in unified-sync-service.ts).
 *
 * The winner still decides the position: the newest page event is where the
 * reader resumes. What newest-wins alone also threw away was the losing copy's
 * READING — a device that missed a sync opens a volume on an old page, one page
 * turn makes its copy the newest, and the other device's page turns and timer
 * minutes were gone on every device. Page turns only ever accumulate, so the
 * merged record carries the union of both sides' turns.
 *
 * When each side holds turns the other never saw, both were read on without
 * the other's reading in view, and the timer keeps the larger count (each side
 * only knows its own minutes since the last sync; the larger one at least
 * loses less). Otherwise the winner's timer stands, so a lowered value from the
 * volume editor is kept.
 *
 * `forgotAt` is the horizon of a "forget this volume's stats" that a later
 * read on the same volume replaced: turns up to it never come back from a
 * stale copy.
 */

type Turn = number[];

export interface VolumeRecordLike {
  timeReadInMinutes?: number;
  recentPageTurns?: Turn[];
  forgotAt?: string;
  archivedReads?: Array<{ at: number }>;
}

const turnKey = (turn: Turn) => `${turn[0]}|${turn[1]}`;

export function mergeLiveVolumeRecords<T extends VolumeRecordLike>(winner: T, loser: T): T {
  const horizon = laterStamp(winner.forgotAt, loser.forgotAt);
  const winnerTurns = afterHorizon(winner.recentPageTurns ?? [], horizon);
  const loserTurns = afterHorizon(loser.recentPageTurns ?? [], horizon);
  if (
    !horizon &&
    winnerTurns.length === 0 &&
    loserTurns.length === 0 &&
    !unionArchivedReads(winner.archivedReads, loser.archivedReads)
  ) {
    return winner;
  }

  const record: T = { ...winner, recentPageTurns: unionTurns(winnerTurns, loserTurns) };
  if (horizon) record.forgotAt = horizon;
  // Restarts are user actions that must survive whichever copy wins: a pass
  // archived on the older copy (another device restarted the series) is kept.
  const archived = unionArchivedReads(winner.archivedReads, loser.archivedReads);
  if (archived) record.archivedReads = archived as T['archivedReads'];

  const winnerKeys = new Set(winnerTurns.map(turnKey));
  const loserKeys = new Set(loserTurns.map(turnKey));
  const diverged =
    loserTurns.some((turn) => !winnerKeys.has(turnKey(turn))) &&
    winnerTurns.some((turn) => !loserKeys.has(turnKey(turn)));
  if (diverged) {
    record.timeReadInMinutes = Math.max(
      winner.timeReadInMinutes ?? 0,
      loser.timeReadInMinutes ?? 0
    );
  }
  return record;
}

/** A live record that won over a "forget stats" tombstone keeps nothing older. */
export function applyForgetHorizon<T extends VolumeRecordLike>(record: T, forgotAt: string): T {
  const horizon = laterStamp(record.forgotAt, forgotAt);
  if (!horizon) return record;
  return {
    ...record,
    forgotAt: horizon,
    recentPageTurns: afterHorizon(record.recentPageTurns ?? [], horizon)
  };
}

function afterHorizon(turns: Turn[], horizon: string | undefined): Turn[] {
  if (!horizon) return turns;
  const cutoff = Date.parse(horizon);
  return turns.filter((turn) => turn[0] > cutoff);
}

function laterStamp(a: string | undefined, b: string | undefined): string | undefined {
  const valid = [a, b].filter((s): s is string => !!s && !Number.isNaN(Date.parse(s)));
  if (valid.length === 0) return undefined;
  return valid.reduce((x, y) => (Date.parse(y) > Date.parse(x) ? y : x));
}

/** Both sides' turns in time order; one turn per (time, page), chars kept. */
function unionTurns(a: Turn[], b: Turn[]): Turn[] {
  const byKey = new Map<string, Turn>();
  for (const turn of [...a, ...b]) {
    const key = turnKey(turn);
    const seen = byKey.get(key);
    // A legacy 2-tuple and its migrated 3-tuple are the same turn.
    if (!seen || (seen.length < 3 && turn.length >= 3)) byKey.set(key, turn);
  }
  return [...byKey.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/** Both sides' archived passes by `at`, in time order; undefined when the loser adds none. */
function unionArchivedReads<R extends { at: number }>(
  winner: R[] | undefined,
  loser: R[] | undefined
): R[] | undefined {
  if (!loser || loser.length === 0) return undefined;
  const byAt = new Map<number, R>();
  for (const read of winner ?? []) byAt.set(read.at, read);
  let added = false;
  for (const read of loser) {
    if (!byAt.has(read.at)) {
      byAt.set(read.at, read);
      added = true;
    }
  }
  return added ? [...byAt.values()].sort((a, b) => a.at - b.at) : undefined;
}
