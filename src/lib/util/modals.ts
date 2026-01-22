import { writable } from 'svelte/store';

type CheckboxOption = {
  label: string;
  storageKey: string;
  defaultValue: boolean;
};

type ConfirmationPopup = {
  open: boolean;
  message: string;
  checkboxOption?: CheckboxOption;
  checkboxOption2?: CheckboxOption;
  onConfirm?: (checkboxValue?: boolean, checkboxValue2?: boolean) => void;
  onCancel?: () => void;
};
export const confirmationPopupStore = writable<ConfirmationPopup | undefined>(undefined);

export function promptConfirmation(
  message: string,
  onConfirm?: (checkboxValue?: boolean, checkboxValue2?: boolean) => void,
  onCancel?: () => void,
  checkboxOption?: CheckboxOption,
  checkboxOption2?: CheckboxOption
) {
  confirmationPopupStore.set({
    open: true,
    message,
    checkboxOption,
    checkboxOption2,
    onConfirm,
    onCancel
  });
}

type ExtractionModal = {
  open: boolean;
  firstVolume?: { series_title: string; volume_title: string };
  onConfirm?: (asCbz: boolean, individualVolumes: boolean, includeSeriesTitle: boolean) => void;
  onCancel?: () => void;
};
export const extractionModalStore = writable<ExtractionModal | undefined>(undefined);

export function promptExtraction(
  firstVolume: { series_title: string; volume_title: string },
  onConfirm?: (asCbz: boolean, individualVolumes: boolean, includeSeriesTitle: boolean) => void,
  onCancel?: () => void
) {
  extractionModalStore.set({
    open: true,
    firstVolume,
    onConfirm,
    onCancel
  });
}

// Image-only import confirmation modal
export type SeriesImportInfo = {
  seriesName: string;
  volumeCount: number;
};

type ImageOnlyImportModal = {
  open: boolean;
  seriesList: SeriesImportInfo[];
  totalVolumes: number;
  onConfirm?: () => void;
  onCancel?: () => void;
};

export const imageOnlyImportModalStore = writable<ImageOnlyImportModal | undefined>(undefined);

export function promptImageOnlyImport(
  seriesList: SeriesImportInfo[],
  totalVolumes: number,
  onConfirm?: () => void,
  onCancel?: () => void
) {
  imageOnlyImportModalStore.set({
    open: true,
    seriesList,
    totalVolumes,
    onConfirm,
    onCancel
  });
}

// Import mismatch modal - shows when mokuro pages don't match downloaded files
export type ImportMismatchInfo = {
  volumeName: string;
  expectedCount: number;
  actualCount: number;
  missingFiles: string[]; // Pages in mokuro that couldn't be matched
  extraFiles: string[]; // Downloaded files that don't match any mokuro page
};

type ImportMismatchModal = {
  open: boolean;
  volumes: ImportMismatchInfo[]; // Support multiple failed volumes
  onDismiss?: () => void;
};

export const importMismatchModalStore = writable<ImportMismatchModal | undefined>(undefined);

/**
 * Show import mismatch modal for one or more failed volumes
 */
export function promptImportMismatch(
  info: ImportMismatchInfo | ImportMismatchInfo[],
  onDismiss?: () => void
) {
  const volumes = Array.isArray(info) ? info : [info];
  importMismatchModalStore.set({
    open: true,
    volumes,
    onDismiss
  });
}

// WebDAV error modal - for detailed error guidance
export type WebDAVErrorType = 'network' | 'auth' | 'connection' | 'permission' | 'unknown';

type WebDAVErrorModal = {
  open: boolean;
  errorType: WebDAVErrorType;
  errorMessage: string;
  serverUrl?: string;
  onRetry?: () => void;
};

export const webdavErrorModalStore = writable<WebDAVErrorModal | undefined>(undefined);

export function showWebDAVError(
  errorType: WebDAVErrorType,
  errorMessage: string,
  serverUrl?: string,
  onRetry?: () => void
) {
  webdavErrorModalStore.set({
    open: true,
    errorType,
    errorMessage,
    serverUrl,
    onRetry
  });
}

export function closeWebDAVError() {
  webdavErrorModalStore.set(undefined);
}

// Missing files warning modal - shows when importing a volume with missing images
export type MissingFilesInfo = {
  volumeName: string;
  missingFiles: string[];
  totalPages: number;
};

type MissingFilesModal = {
  open: boolean;
  info: MissingFilesInfo;
  onImportAnyway?: () => void;
  onCancel?: () => void;
};

export const missingFilesModalStore = writable<MissingFilesModal | undefined>(undefined);

/**
 * Show missing files warning modal with import anyway option
 */
export function promptMissingFiles(
  info: MissingFilesInfo,
  onImportAnyway?: () => void,
  onCancel?: () => void
) {
  missingFilesModalStore.set({
    open: true,
    info,
    onImportAnyway,
    onCancel
  });
}

// Volume editor modal - for editing volume metadata, stats, and cover
type VolumeEditorModal = {
  open: boolean;
  volumeUuid: string;
  onSave?: () => void;
  onCancel?: () => void;
};

export const volumeEditorModalStore = writable<VolumeEditorModal | undefined>(undefined);

export function promptVolumeEditor(volumeUuid: string, onSave?: () => void, onCancel?: () => void) {
  volumeEditorModalStore.set({
    open: true,
    volumeUuid,
    onSave,
    onCancel
  });
}

export function closeVolumeEditor() {
  volumeEditorModalStore.set(undefined);
}

// Import preparing modal - shows progress while scanning/analyzing dropped files
export type ImportPreparingPhase = 'scanning' | 'analyzing' | 'preparing';

type ImportPreparingModal = {
  open: boolean;
  phase: ImportPreparingPhase;
  filesScanned?: number;
  totalFiles?: number;
  volumesFound?: number;
};

export const importPreparingModalStore = writable<ImportPreparingModal | undefined>(undefined);

/**
 * Show import preparing modal with current phase
 */
export function showImportPreparing(
  phase: ImportPreparingPhase,
  details?: Partial<ImportPreparingModal>
) {
  importPreparingModalStore.set({
    open: true,
    phase,
    ...details
  });
}

/**
 * Update import preparing modal with new details
 */
export function updateImportPreparing(details: Partial<ImportPreparingModal>) {
  importPreparingModalStore.update((current) => {
    if (!current) return current;
    return { ...current, ...details };
  });
}

/**
 * Close import preparing modal
 */
export function closeImportPreparing() {
  importPreparingModalStore.set(undefined);
}
