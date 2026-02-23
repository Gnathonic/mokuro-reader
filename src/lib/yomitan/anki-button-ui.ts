export type YomitanAnkiButtonState =
  | 'ready'
  | 'duplicate'
  | 'adding'
  | 'added'
  | 'error'
  | 'unknown';

export interface YomitanAnkiButtonUiState {
  state: YomitanAnkiButtonState;
  disabled?: boolean;
  label?: string;
  title?: string;
}

export type YomitanAnkiButtonVariant = 'primary' | 'warning' | 'success' | 'danger' | 'muted';

export function resolveAnkiButtonUiState(state: YomitanAnkiButtonState): {
  label: string;
  title: string;
  disabled: boolean;
  variant: YomitanAnkiButtonVariant;
} {
  switch (state) {
    case 'ready':
      return {
        label: 'Add to Anki',
        title: 'Add this entry to Anki.',
        disabled: false,
        variant: 'primary'
      };
    case 'duplicate':
      return {
        label: 'Add duplicate',
        title: 'Already exists in Anki; adding another copy.',
        disabled: false,
        variant: 'warning'
      };
    case 'adding':
      return {
        label: 'Adding...',
        title: 'Adding this entry to Anki.',
        disabled: true,
        variant: 'muted'
      };
    case 'added':
      return {
        label: 'Added \u2713',
        title: 'Added to Anki.',
        disabled: true,
        variant: 'success'
      };
    case 'error':
      return {
        label: 'Retry',
        title: 'Last add failed; click to retry.',
        disabled: false,
        variant: 'danger'
      };
    case 'unknown':
      return {
        label: 'Add to Anki',
        title: 'Could not verify duplicates; add may create a duplicate.',
        disabled: false,
        variant: 'primary'
      };
  }
}
