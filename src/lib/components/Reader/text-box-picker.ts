import { writable } from 'svelte/store';
import type { Page } from '$lib/types';
import type { VolumeMetadata } from '$lib/anki-connect';

interface TextBoxPickerState {
  open: boolean;
  image?: string;
  page?: Page;
  tags?: string;
  metadata?: VolumeMetadata;
}

export const textBoxPickerStore = writable<TextBoxPickerState>({ open: false });

export function showTextBoxPicker(
  image: string,
  page: Page,
  tags?: string,
  metadata?: VolumeMetadata
) {
  textBoxPickerStore.set({ open: true, image, page, tags, metadata });
}
