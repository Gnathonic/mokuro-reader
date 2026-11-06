import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import type { Page } from '$lib/types';

const h = vi.hoisted(() => ({ showSnackbar: vi.fn() }));

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({
      ankiConnectSettings: {
        enabled: true,
        cardMode: 'update',
        url: 'http://192.168.1.10:8765'
      }
    })
  };
});

vi.mock('$lib/util', () => ({ showSnackbar: h.showSnackbar }));

vi.mock('$lib/anki-connect', () => ({
  expandTextBoxBounds: vi.fn(() => [0, 0, 10, 10]),
  extractFieldValues: vi.fn(),
  getCardAgeInMin: vi.fn(),
  getLastCardInfo: vi.fn(),
  getModelConfig: vi.fn(),
  openCreateModal: vi.fn(),
  openUpdateModal: vi.fn(),
  sendQuickCapture: vi.fn()
}));

import TextBoxPicker from '../TextBoxPicker.svelte';
import { showTextBoxPicker } from '../text-box-picker';
import { getLastCardInfo } from '$lib/anki-connect';
import { settings } from '$lib/settings';
import { get, type Writable } from 'svelte/store';

const settingsStore = settings as unknown as Writable<Record<string, any>>;
const initialSettings = get(settingsStore);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // A test that points the URL elsewhere must not leak it into the next one.
  settingsStore.set(initialSettings);
});

async function pickAndContinue() {
  const { getByText, container } = render(TextBoxPicker);
  showTextBoxPicker('blob:page', page);
  const zone = () => container.ownerDocument.querySelector('.textbox-zone');
  await waitFor(() => expect(zone()).not.toBeNull());
  await fireEvent.click(zone()!);
  await fireEvent.click(getByText('Continue'));
}

const page: Page = {
  version: '0.2.2',
  img_width: 1000,
  img_height: 1000,
  img_path: 'page_001.jpg',
  blocks: [
    {
      box: [100, 100, 200, 300],
      vertical: true,
      font_size: 30,
      lines: ['一行目']
    }
  ] as Page['blocks']
};

describe('TextBoxPicker: update mode with an unconfirmed AnkiConnect URL', () => {
  // The client answers an unconfirmed URL with its notice and no result; the
  // picker used to read that as "no recent card" and replace the notice (the
  // snackbar holds one message) with "No recent card found to update".
  it('tells the user to confirm the URL, without looking for a card', async () => {
    await pickAndContinue();

    await waitFor(() => expect(h.showSnackbar).toHaveBeenCalled());
    expect(h.showSnackbar).toHaveBeenCalledTimes(1);
    expect(h.showSnackbar.mock.calls[0][0]).toContain(
      'http://192.168.1.10:8765 is not confirmed on this device'
    );
    expect(getLastCardInfo).not.toHaveBeenCalled();
  });

  it('Anki on this machine is asked for the last card as before', async () => {
    settingsStore.update((v) => ({
      ...v,
      ankiConnectSettings: { ...v.ankiConnectSettings, url: 'http://127.0.0.1:8765' }
    }));
    await pickAndContinue();

    await waitFor(() => expect(getLastCardInfo).toHaveBeenCalledTimes(1));
    expect(h.showSnackbar).toHaveBeenCalledWith('No recent card found to update');
  });
});
