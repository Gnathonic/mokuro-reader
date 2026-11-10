import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';

vi.mock('$lib/util', () => ({
  promptConfirmation: (_message: string, onConfirm?: () => void) => onConfirm?.(),
  showSnackbar: vi.fn()
}));

import KeyboardShortcuts from '../KeyboardShortcuts.svelte';
import { allActions } from '$lib/keys/registry';
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
    // Hand-registered, generated from the setting definitions, one per profile.
    const all = allActions();
    expect(all.length).toBeGreaterThan(190);
    const rows = [...container.querySelectorAll('[data-key-action]')].map((r) =>
      r.getAttribute('data-key-action')
    );
    expect([...rows].sort()).toEqual(all.map((a) => a.id).sort());
    // Every row shows its action's icon.
    expect(container.querySelectorAll('[data-key-action] svg').length).toBeGreaterThanOrEqual(
      all.length
    );
    for (const group of [
      'Pages',
      'Scrolling',
      'View',
      'OCR',
      'Filters',
      'Edit mode',
      'Library',
      'General',
      'Other views'
    ]) {
      expect(getByText(group, { selector: 'h4' })).toBeTruthy();
    }
    expect(getByText('Not changeable')).toBeTruthy();
    expect(getByText(/Saved in profile/).textContent).toContain('Desktop');
  });

  it('filters by action name', async () => {
    const { container, getByLabelText } = render(KeyboardShortcuts, { open: true });
    await fireEvent.input(getByLabelText('Filter keyboard shortcuts'), {
      target: { value: 'timer' }
    });
    await tick();
    const rows = [...container.querySelectorAll('[data-key-action]')].map((r) =>
      r.getAttribute('data-key-action')
    );
    expect(rows).toEqual(['reader.timer']);
  });

  it('finds a generated action by its setting’s name, and every action under it', async () => {
    const { container, getByLabelText } = render(KeyboardShortcuts, { open: true });
    await fireEvent.input(getByLabelText('Filter keyboard shortcuts'), {
      target: { value: 'paged zoom' }
    });
    await tick();
    const rows = [...container.querySelectorAll('[data-key-action]')].map((r) =>
      r.getAttribute('data-key-action')
    );
    expect(rows).toEqual([
      'set.zoom-paged.next',
      'set.zoom-paged.prev',
      'set.zoom-paged.to.zoomFitToScreen',
      'set.zoom-paged.to.zoomFitToWidth',
      'set.zoom-paged.to.zoomFillScreen',
      'set.zoom-paged.to.zoomOriginal',
      'set.zoom-paged.to.keepZoom'
    ]);
    // New actions ship unbound.
    for (const row of container.querySelectorAll('[data-key-action]')) {
      expect(row.textContent).toContain('Not set');
    }
  });

  it('lists a “Set to” action for a profile as soon as it exists', async () => {
    const { container, getByLabelText } = render(KeyboardShortcuts, { open: true });
    createProfile('Keys Section Profile');
    await fireEvent.input(getByLabelText('Filter keyboard shortcuts'), {
      target: { value: 'Keys Section Profile' }
    });
    await tick();
    expect(
      container.querySelector('[data-key-action="set.profile.to.Keys Section Profile"]')
    ).toBeTruthy();
  });

  it('a generated action records a key like any other, and conflicts are seen across both kinds', async () => {
    updateSetting('keyBindings', { 'set.bold.toggle': ['KeyF'] });
    const { container } = render(KeyboardShortcuts, { open: true });
    await tick();
    for (const id of ['reader.fullscreen', 'set.bold.toggle']) {
      const row = container.querySelector(`[data-key-action="${id}"]`)!;
      expect(row.querySelector('[aria-label="Shares a key with another action"]'), id).toBeTruthy();
    }
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
    updateSetting('quickMenu', { 'set.bold.toggle': true });
    const { getByText } = render(KeyboardShortcuts, { open: true });
    await fireEvent.click(getByText('Copy to all profiles'));
    for (const p of Object.values(get(profiles))) {
      expect(p.keyBindings).toEqual({ 'reader.page-right': ['ArrowRight', 'KeyD'] });
      expect(p.quickMenu).toEqual({ 'set.bold.toggle': true });
    }
    updateSetting('quickMenu', {});
  });
});
