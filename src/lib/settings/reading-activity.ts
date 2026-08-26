/**
 * ONE definition of "the user has actually read this volume".
 *
 * Deliberately a zero-import leaf: every consumer of the reading-state store
 * lives downstream of it (`$lib/catalog`, `$lib/metadata`, the views), so a
 * module with no imports of its own can be depended on from any of them
 * without risking a cycle.
 *
 * WHY IT IS SHARED RATHER THAN INLINED. This app already carries a
 * user-visible bug caused by four sites each rolling their own "is this
 * finished?" and drifting apart. The same question is now asked from at least
 * two places for two different reasons — whether a cover belongs on the row
 * (`cover-persist.ts`) and whether a volume earns a row at all
 * (`history-rows.ts`) — and the two MUST agree: a cover routed to the row for
 * a volume that never earned one is a blob written to a table that has no
 * place to hold it, and a row minted for a volume the cover gate calls inert
 * is a row that never gets a cover. Import this; never re-implement it.
 */

/**
 * Loosely-typed on purpose: the reading-state store's entries are `VolumeData`
 * instances in production, but this only needs to read a handful of fields,
 * structurally, so a test's hand-rolled mock doesn't have to construct a real
 * instance.
 */
export interface ReadingHistoryEntry {
  progress?: number;
  chars?: number;
  completed?: boolean;
  timeReadInMinutes?: number;
  recentPageTurns?: unknown[];
  sessions?: unknown[];
  archivedReads?: unknown[];
}

/**
 * Does this reading-state entry represent actual reading activity, not just
 * the settings key every volume gets the moment it is imported
 * (`initializeVolume`)?
 *
 * The user's rule, verbatim and binding: *"'reading history' is a broad term
 * in this case. Even if we don't have page turn data or recorded times, if the
 * user has it marked-as-finished, it still counts."* So `completed` alone
 * qualifies — measured on a real library, exactly one of 726 qualifying
 * entries had `completed` and nothing else, which is precisely the kind of
 * single record a narrower rule would quietly throw away.
 *
 * `archivedReads` counts too: "restart series" zeroes `progress`/`chars`/
 * `completed` while archiving the prior pass as the record that reading
 * happened.
 */
export function hasReadingActivity(entry: ReadingHistoryEntry | undefined | null): boolean {
  if (!entry) return false;
  return (
    (entry.progress ?? 0) > 0 ||
    (entry.chars ?? 0) > 0 ||
    !!entry.completed ||
    (entry.timeReadInMinutes ?? 0) > 0 ||
    (entry.recentPageTurns?.length ?? 0) > 0 ||
    (entry.sessions?.length ?? 0) > 0 ||
    (entry.archivedReads?.length ?? 0) > 0
  );
}
