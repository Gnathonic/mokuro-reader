import { writable } from 'svelte/store';

type ConfirmationPopup = {
  open: boolean;
  message: string;
  showStatsOption?: boolean;
  onConfirm?: (deleteStats?: boolean) => void;
  onCancel?: () => void;
};
export const confirmationPopupStore = writable<ConfirmationPopup | undefined>(undefined);

export function promptConfirmation(
  message: string, 
  onConfirm?: (deleteStats?: boolean) => void, 
  onCancel?: () => void,
  showStatsOption: boolean = false
) {
  confirmationPopupStore.set({
    open: true,
    message,
    showStatsOption,
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
