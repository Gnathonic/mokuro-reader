import { progressTrackerStore } from './progress-tracker';
import { showSnackbar } from './snackbar';

export interface BackupUiBridge {
  addProgress(processId: string, description: string, status: string, progress: number): void;
  updateProgress(processId: string, status: string, progress: number): void;
  removeProgress(processId: string): void;
  notify(message: string): void;
}

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
    showSnackbar(message);
  }
};

export function getBackupUiBridge(): BackupUiBridge {
  return uiBridge;
}

export function setBackupUiBridge(nextBridge: BackupUiBridge): void {
  uiBridge = nextBridge;
}
