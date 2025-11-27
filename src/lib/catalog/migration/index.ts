// Types
export type { MigrationProgressCallback, MigrationProgress, MigrationPhase } from './types';

// Detection
export { checkMigrationNeeded, deleteOldDatabase } from './detection';

// Migration
export {
  runMigration,
  rollbackMigration,
  calculateCumulativeCharCounts,
  getMigrationDebugLog,
  clearMigrationDebugLog
} from './migrate';
