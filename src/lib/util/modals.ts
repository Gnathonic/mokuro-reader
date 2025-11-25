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
