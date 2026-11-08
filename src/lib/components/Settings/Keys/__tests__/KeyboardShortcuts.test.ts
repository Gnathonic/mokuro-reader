import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';

vi.mock('$lib/util', () => ({
  promptConfirmation: (_message: string, onConfirm?: () => void) => onConfirm?.(),
  showSnackbar: vi.fn()
}));

import KeyboardShortcuts from '../KeyboardShortcuts.svelte';
import { KEY_ACTIONS } from '$lib/keys/actions';
import {
  changeProfile,
  createProfile,
  profiles,
  settings,
  updateSetting
} from '$lib/settings/settings';

beforeEach(() => {
  changeProfile('Desktop');
  updateSetting('keyBindings', {});
});
afterEach(() => cleanup());

describe('KeyboardShortcuts', () => {
  it('lists every registry action, grouped, with the fixed inputs read-only', () => {
    const { container, getByText } = render(KeyboardShortcuts, { open: true });
    expect(container.querySelectorAll('[data-key-action]')).toHaveLength(KEY_ACTIONS.length);
    for (const group of [
      'Pages',
      'Scrolling',
      'View',
      'OCR',
      'Filters',
      'Edit mode',
      'Library',
      'General'
    ]) {
      expect(getByText(group, { selector: 'h4' })).toBeTruthy();
    }
    expect(getByText('Not changeable')).toBeTruthy();
    expect(getByText(/Saved in profile/).textContent).toContain('Desktop');
  });

  it('filters by action name', async () => {
    const { container, getByPlaceholderText } = render(KeyboardShortcuts, { open: true });
    await fireEvent.input(getByPlaceholderText('Filter actions'), { target: { value: 'timer' } });
    await tick();
    const rows = [...container.querySelectorAll('[data-key-action]')].map((r) =>
      r.getAttribute('data-key-action')
    );
    expect(rows).toEqual(['reader.timer']);
  });

  it('saves edits into the profile; Reset all clears them', async () => {
    const { getByLabelText, getByText } = render(KeyboardShortcuts, { open: true });
    await fireEvent.click(getByLabelText('Remove F from Fullscreen'));
    expect(get(settings).keyBindings).toEqual({ 'reader.fullscreen': [] });
    await tick();
    await fireEvent.click(getByText('Reset all shortcuts'));
    expect(get(settings).keyBindings).toEqual({});
  });

  it('flags a stored conflict on both rows', async () => {
    updateSetting('keyBindings', { 'reader.fullscreen': ['KeyN'] });
    const { container } = render(KeyboardShortcuts, { open: true });
    await tick();
    for (const id of ['reader.fullscreen', 'reader.night']) {
      const row = container.querySelector(`[data-key-action="${id}"]`)!;
      expect(row.querySelector('[aria-label="Shares a key with another action"]'), id).toBeTruthy();
    }
  });

  it('Copy to all profiles writes the map into every profile', async () => {
    createProfile('KeysCopyTarget');
    updateSetting('keyBindings', { 'reader.page-right': ['ArrowRight', 'KeyD'] });
    const { getByText } = render(KeyboardShortcuts, { open: true });
    await fireEvent.click(getByText('Copy to all profiles'));
    for (const p of Object.values(get(profiles))) {
      expect(p.keyBindings).toEqual({ 'reader.page-right': ['ArrowRight', 'KeyD'] });
    }
  });
});
