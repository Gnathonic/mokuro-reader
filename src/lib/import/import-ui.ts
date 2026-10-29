import { progressTrackerStore } from '$lib/util/progress-tracker';
import { showSnackbar } from '$lib/util/snackbar';
import { promptMissingFiles } from '$lib/util/modals';
import { appendReviewGroups, type OnGroupDecision } from './review-session';
import type { ReviewGroup } from './image-only-review';
import type { MissingFilesInfo } from '$lib/util/modals';
export type { MissingFilesInfo } from '$lib/util/modals';

export interface ImportUiBridge {
  addProgress(processId: string, description: string, status: string, progress: number): void;
  updateProgress(processId: string, status: string, progress: number): void;
  removeProgress(processId: string): void;
  notify(message: string): void;
  /**
   * Offer image-only volumes for review, one series group per step (#285).
   * Never blocks: `onDecision` is called once per group, whenever the user
   * decides it (Import, Skip, or Skip all remaining).
   */
  reviewImageOnly(groups: ReviewGroup[], onDecision: OnGroupDecision): void;
  promptMissing(info: MissingFilesInfo): Promise<boolean>;
}

let uiBridge: ImportUiBridge = {
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
  },
  reviewImageOnly: (groups, onDecision) => appendReviewGroups(groups, onDecision),
  promptMissing: (info) =>
    new Promise<boolean>((resolve) => {
      promptMissingFiles(
        info,
        () => resolve(true),
        () => resolve(false)
      );
    })
};

export function getImportUiBridge(): ImportUiBridge {
  return uiBridge;
}

export function setImportUiBridge(nextBridge: ImportUiBridge): void {
  uiBridge = nextBridge;
}
