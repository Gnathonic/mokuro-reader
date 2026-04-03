import { progressTrackerStore } from '$lib/util/progress-tracker';
import { showSnackbar } from '$lib/util/snackbar';
import { promptMissingFiles, promptImageOnlyImport } from '$lib/util/modals';
import type { MissingFilesInfo, SeriesImportInfo as ModalSeriesImportInfo } from '$lib/util/modals';
export type { MissingFilesInfo } from '$lib/util/modals';

export interface SeriesImportInfo {
  seriesList: ModalSeriesImportInfo[];
  totalVolumeCount: number;
}

export interface ImportUiBridge {
  addProgress(processId: string, description: string, status: string, progress: number): void;
  updateProgress(processId: string, status: string, progress: number): void;
  removeProgress(processId: string): void;
  notify(message: string): void;
  promptImageOnly(info: SeriesImportInfo): Promise<boolean>;
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
  promptImageOnly: (info) =>
    new Promise<boolean>((resolve) => {
      promptImageOnlyImport(
        info.seriesList,
        info.totalVolumeCount,
        () => resolve(true),
        () => resolve(false)
      );
    }),
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
