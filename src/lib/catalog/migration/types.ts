export type MigrationPhase =
  | 'counting'
  | 'loading_series'
  | 'writing_volume'
  | 'deleting_source'
  | 'complete';

export interface MigrationProgress {
  phase: MigrationPhase;
  volumesCurrent: number;
  volumesTotal: number;
  volumeTitle?: string;
  seriesTitle?: string;
  seriesCurrent?: number;
  seriesTotal?: number;
}

export type MigrationProgressCallback = (progress: MigrationProgress) => void;
