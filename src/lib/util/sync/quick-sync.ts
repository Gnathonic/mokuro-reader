/**
 * The QUICK tier (`docs/superpowers/specs/2026-10-16-sync-tiers-design.md`):
 * everything a cold client needs to show the right progress, fetched by known
 * path BEFORE the first full listing has loaded — the listing is the slow part
 * of every start (on Drive a paged walk of the whole account).
 *
 * - progress: `volume-data.json`, merged (`quickMergeVolumeData`)
 * - positions: `positions.json`, adopted (`probePositions`)
 * - history: other devices' segments under `history/`, imported
 *   (`listFolder` + `importHistory`)
 *
 * All three are READ-ONLY. Every write — uploads, the duplicate sweep, this
 * device's own history months — stays with the full sync, which runs once the
 * listing shows every copy a write must not clobber. Each half merges
 * newest-wins or unions by id, so the full sync re-doing them changes nothing.
 *
 * Started by `fetchAllCloudVolumes` when nothing is listed yet. Callers list
 * only after their login finished, so per-user gates (bunko) are settled.
 * Never throws; one line in the console says what it did.
 */

import { historySyncAllowed } from '$lib/reading-history/history-capability';
import type { SyncProvider } from './provider-interface';
import { unifiedSyncService } from './unified-sync-service';

export interface QuickSyncReport {
  progress: 'merged' | 'none' | 'failed' | 'unsupported';
  positions: number;
  history: number | 'failed' | 'unsupported' | 'off';
  ms: number;
}

async function quickProgress(provider: SyncProvider): Promise<QuickSyncReport['progress']> {
  if (!provider.readRootFileCopies) return 'unsupported';
  try {
    return (await unifiedSyncService.quickMergeVolumeData(provider)) ? 'merged' : 'none';
  } catch (error) {
    console.warn('[quick-sync] progress failed (the full sync follows):', error);
    return 'failed';
  }
}

async function quickPositions(provider: SyncProvider): Promise<number> {
  try {
    const { probePositions } = await import('$lib/positions/positions-sync');
    return (await probePositions(provider)).adopted.length;
  } catch (error) {
    console.warn('[quick-sync] positions failed (the full sync follows):', error);
    return 0;
  }
}

async function quickHistory(provider: SyncProvider): Promise<QuickSyncReport['history']> {
  if (!provider.listFolder) return 'unsupported';
  if (!historySyncAllowed(provider.getStatus())) return 'off';
  try {
    const [{ importHistory }, { historyDb }, { HISTORY_FOLDER, isHistoryFilePath }] =
      await Promise.all([
        import('$lib/reading-history/history-sync'),
        import('$lib/reading-history/history-db'),
        import('$lib/reading-history/paths')
      ]);
    const listing = (await provider.listFolder(HISTORY_FOLDER)).filter((file) =>
      isHistoryFilePath(file.path)
    );
    return await importHistory(provider, listing, historyDb());
  } catch (error) {
    console.warn('[quick-sync] history failed (the full sync follows):', error);
    return 'failed';
  }
}

const inFlight = new Map<string, Promise<QuickSyncReport>>();

/** Run the quick tier for `provider`; a run already in flight for it answers instead. */
export function runQuickSync(provider: SyncProvider): Promise<QuickSyncReport> {
  const running = inFlight.get(provider.type);
  if (running) return running;
  const started = Date.now();
  const run = Promise.all([
    quickProgress(provider),
    quickPositions(provider),
    quickHistory(provider)
  ]).then(([progress, positions, history]) => {
    const report: QuickSyncReport = { progress, positions, history, ms: Date.now() - started };
    console.log(
      `⚡ Quick sync (${provider.name}) in ${report.ms} ms: progress ${progress}, ` +
        `${positions} position(s) adopted, history ${
          typeof history === 'number' ? `+${history} event(s)` : history
        } — the full sync follows the listing`
    );
    return report;
  });
  const tracked = run.finally(() => inFlight.delete(provider.type));
  inFlight.set(provider.type, tracked);
  return tracked;
}

export function _resetQuickSyncForTests(): void {
  inFlight.clear();
}
