import { progressTrackerStore } from './progress-tracker';
import { showSnackbar } from './snackbar';

export interface BackupUiBridge {
  addProgress(processId: string, description: string, status: string, progress: number): void;
  updateProgress(processId: string, status: string, progress: number): void;
  removeProgress(processId: string): void;
  notify(message: string): void;
  /** A failure notice: shown longer, and not overwritten by the success notices of a run. */
  notifyError?(message: string): void;
}

/** A failure notice holds the snackbar this long; success notices wait it out. */
const ERROR_NOTICE_MS = 10_000;
let errorNoticeUntil = 0;

let uiBridge: BackupUiBridge = {
  addProgress: (processId, description, status, progress) => {
    progressTrackerStore.addProcess({ id: processId, description, status, progress });
  },
  updateProgress: (processId, status, progress) => {
    progressTrackerStore.updateProcess(processId, { status, progress });
  },
  removeProgress: (processId) => {
    progressTrackerStore.removeProcess(processId);
  },
  notify: (message) => {
    // The snackbar has one slot: with several uploads in flight, the next
    // "Backed up X" would wipe a failure out after a moment. Successes yield.
    if (Date.now() < errorNoticeUntil) return;
    showSnackbar(message);
  },
  notifyError: (message) => {
    errorNoticeUntil = Date.now() + ERROR_NOTICE_MS;
    showSnackbar(message, ERROR_NOTICE_MS);
  }
};

export function getBackupUiBridge(): BackupUiBridge {
  return uiBridge;
}

export function setBackupUiBridge(nextBridge: BackupUiBridge): void {
  uiBridge = nextBridge;
}
