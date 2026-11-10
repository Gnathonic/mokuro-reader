import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';

vi.mock('$lib/util', () => ({
  promptConfirmation: (_message: string, onConfirm?: () => void) => onConfirm?.(),
  showSnackbar: vi.fn()
}));

import KeyboardShortcuts, { SEARCH_DELAY_MS } from '../KeyboardShortcuts.svelte';
import { GROUP_LABELS, GROUP_ORDER } from '$lib/keys/actions';
import { chordLabel } from '$lib/keys/live';
import { menuEligible } from '$lib/keys/quick-menu';
import { allActions } from '$lib/keys/registry';
import { MATCH_LIMIT } from '$lib/keys/targets';
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
  updateSetting('quickMenu', {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Opened, with a search applied at once (the pause before it has tests of its own). */
const AT_ONCE = { open: true, searchDelay: 0 };

/** What the helpers need of a rendered section. */
type Section = { container: HTMLElement; getByLabelText: (text: string) => HTMLElement };

const rowIds = (c: Element) =>
  [...c.querySelectorAll('[data-key-action]')].map((r) => r.getAttribute('data-key-action'));
const row = (c: Element, id: string) => c.querySelector(`[data-key-action="${id}"]`);
const group = (c: Element, id: string) => c.querySelector(`[data-key-group="${id}"]`)!;
const groupButton = (c: Element, id: string) => group(c, id).querySelector('h4 button')!;
const settingRow = (c: Element, def: string) =>
  c.querySelector(`[data-key-setting="setting:${def}"]`);
const CONFLICT = '[aria-label="Shares a key with another action"]';
const HOLDS_CONFLICT = '[aria-label="Holds a key shared with another action"]';

async function search(section: Section, text: string) {
  await fireEvent.input(section.getByLabelText('Search shortcuts'), { target: { value: text } });
  await tick();
}

async function openGroup(section: Section, id: string) {
  await fireEvent.click(groupButton(section.container, id));
  await tick();
}

describe('Shortcuts and quick menu: groups', () => {
  it('is titled for both, and lists the target list’s areas collapsed, mounting no rows', () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container, getByText } = section;
    expect(getByText('Shortcuts and quick menu')).toBeTruthy();
    expect(
      [...container.querySelectorAll('[data-key-group]')].map((g) =>
        g.getAttribute('data-key-group')
      )
    ).toEqual([...GROUP_ORDER]);
    expect(
      [...container.querySelectorAll('[data-key-group-label]')].map((l) => l.textContent)
    ).toEqual(GROUP_ORDER.map((g) => GROUP_LABELS[g]));
    // Closed: not one of the 250 action rows, nor a setting row, is mounted.
    expect(rowIds(container)).toEqual([]);
    expect(container.querySelectorAll('[data-key-setting]')).toHaveLength(0);
    for (const g of GROUP_ORDER) {
      expect(groupButton(container, g).getAttribute('aria-expanded'), g).toBe('false');
    }
    expect(getByText('Not changeable')).toBeTruthy();
    expect(getByText(/Saved in profile/).textContent).toContain('Desktop');
  });

  it('shows each group’s row count: about 130 rows for the 250 actions', () => {
    const { container } = render(KeyboardShortcuts, AT_ONCE);
    const counts = [...container.querySelectorAll('[data-key-group-count]')].map((c) =>
      Number(c.textContent)
    );
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(120);
    expect(total).toBeLessThan(140);
    expect(allActions().length).toBeGreaterThan(240);
    expect(container.querySelectorAll('[data-key-group-changed]')).toHaveLength(0);
  });

  it('an opened group mounts one row per target: commands and toggles as rows, lists and sliders folded', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await openGroup(section, 'image');
    expect(groupButton(container, 'image').getAttribute('aria-expanded')).toBe('true');
    // Three toggles are rows; the print effect and the five sliders are folded.
    expect(rowIds(container)).toEqual(['reader.night', 'reader.invert', 'reader.grayscale']);
    expect(
      [...container.querySelectorAll('[data-key-setting]')].map((r) =>
        r.getAttribute('data-key-setting')
      )
    ).toEqual([
      'setting:brightness',
      'setting:contrast',
      'setting:ink-color',
      'setting:ink-strength',
      'setting:paper-tint',
      'setting:paper-age'
    ]);
    expect(
      Number(group(container, 'image').querySelector('[data-key-group-count]')!.textContent)
    ).toBe(9);
    // Every row shows its icon.
    expect(row(container, 'reader.night')!.querySelector('svg')).not.toBeNull();
    expect(settingRow(container, 'brightness')!.querySelector('svg')).not.toBeNull();
    // Closing it unmounts them again.
    await openGroup(section, 'image');
    expect(rowIds(container)).toEqual([]);
  });
});

describe('Shortcuts and quick menu: folded settings', () => {
  it('a closed setting row says what is inside; opening it lists its actions by their short names', async () => {
    updateSetting('keyBindings', {
      'set.brightness.up': ['BracketRight'],
      'set.brightness.down': ['BracketLeft']
    });
    updateSetting('quickMenu', { 'set.brightness.reset': true });
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await openGroup(section, 'image');
    const brightness = settingRow(container, 'brightness')!;
    expect(brightness.querySelector('[data-key-setting-summary]')!.textContent).toBe(
      '3 actions · 2 keys · 1 on the quick menu'
    );
    expect(settingRow(container, 'contrast')!.textContent).toContain('3 actions');
    expect(settingRow(container, 'contrast')!.textContent).not.toContain('key');
    // Closed: its three actions are not mounted.
    expect(row(container, 'set.brightness.up')).toBeNull();

    await fireEvent.click(brightness.querySelector('button')!);
    await tick();
    expect(rowIds(brightness)).toEqual([
      'set.brightness.up',
      'set.brightness.down',
      'set.brightness.reset'
    ]);
    const title = (id: string) =>
      row(container, id)!.querySelector('.font-medium')!.textContent!.trim();
    expect(title('set.brightness.up')).toBe('Step up');
    expect(title('set.brightness.reset')).toBe('Reset');
    expect(row(container, 'set.brightness.up')!.querySelector('[data-key-chip]')).not.toBeNull();
    // The group counts the changed row once.
    expect(group(container, 'image').querySelector('[data-key-group-changed]')!.textContent).toBe(
      '1 changed'
    );
  });

  it('a conflict’s amber icon shows on the closed group and on the closed setting that hold it', async () => {
    // F is Fullscreen's (Reader: view); the same key on a brightness step (Reader: image).
    updateSetting('keyBindings', { 'set.brightness.up': ['KeyF'] });
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await tick();
    expect(groupButton(container, 'image').querySelector(HOLDS_CONFLICT)).not.toBeNull();
    expect(groupButton(container, 'view').querySelector(HOLDS_CONFLICT)).not.toBeNull();
    expect(groupButton(container, 'text').querySelector(HOLDS_CONFLICT)).toBeNull();

    await openGroup(section, 'image');
    expect(settingRow(container, 'brightness')!.querySelector(HOLDS_CONFLICT)).not.toBeNull();
    expect(settingRow(container, 'contrast')!.querySelector(HOLDS_CONFLICT)).toBeNull();
    await fireEvent.click(settingRow(container, 'brightness')!.querySelector('button')!);
    await tick();
    expect(row(container, 'set.brightness.up')!.querySelector(CONFLICT)).not.toBeNull();
    expect(row(container, 'set.brightness.down')!.querySelector(CONFLICT)).toBeNull();
    await openGroup(section, 'view');
    expect(row(container, 'reader.fullscreen')!.querySelector(CONFLICT)).not.toBeNull();
  });
});

describe('Shortcuts and quick menu: search and filters', () => {
  it('a search opens what matches and hides the rest', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await search(section, 'timer');
    // The setting's toggle (show the timer) and the command (pause or resume).
    expect(rowIds(container)).toEqual(['reader.timer', 'reader.timer-pause']);
    expect(
      [...container.querySelectorAll('[data-key-group]')].map((g) =>
        g.getAttribute('data-key-group')
      )
    ).toEqual(['view', 'volume']);
    // Clearing it folds everything away again.
    await search(section, '');
    expect(rowIds(container)).toEqual([]);
    expect(container.querySelectorAll('[data-key-group]')).toHaveLength(GROUP_ORDER.length);
  });

  it('finds a setting by its name, opened with every action under it', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await search(section, 'paged zoom');
    expect(rowIds(container)).toEqual([
      'set.zoom-paged.next',
      'set.zoom-paged.prev',
      'set.zoom-paged.to.zoomFitToScreen',
      'set.zoom-paged.to.zoomFitToWidth',
      'set.zoom-paged.to.zoomFillScreen',
      'set.zoom-paged.to.zoomOriginal',
      'set.zoom-paged.to.keepZoom'
    ]);
    expect(
      settingRow(container, 'zoom-paged')!.querySelector('button')!.getAttribute('aria-expanded')
    ).toBe('true');
    // New actions ship unbound.
    for (const r of container.querySelectorAll('[data-key-action]')) {
      expect(r.textContent).toContain('Not set');
    }
  });

  it('finds an option by its name, an area by its name, and an action by its key’s label', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await search(section, 'fit to width');
    expect(rowIds(container)).toEqual(['set.zoom-paged.to.zoomFitToWidth']);
    await search(section, 'series editor');
    expect(rowIds(container)).toContain('series-editor.next-unlinked');
    expect(rowIds(container)).toContain('series-editor.next-untitled');
    // The label the chip shows for Space's neighbour, whatever this device calls it.
    await search(section, chordLabel('PageDown'));
    expect(rowIds(container)).toEqual(['reader.page-next']);
    await search(section, 'nothing is called this');
    expect(rowIds(container)).toEqual([]);
    expect(container.querySelector('[data-key-no-match]')!.textContent).toContain(
      'nothing is called this'
    );
  });

  it('lists a “Set to” action for a profile as soon as it exists', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    createProfile('Keys Section Profile');
    await search(section, 'Keys Section Profile');
    expect(row(section.container, 'set.profile.to.Keys Section Profile')).toBeTruthy();
  });

  it('filters: Has a key, Changed, On the quick menu', async () => {
    updateSetting('keyBindings', { 'set.bold.toggle': ['KeyB'], 'reader.fullscreen': [] });
    updateSetting('quickMenu', { 'set.brightness.up': true });
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container, getByText } = section;
    const press = async (label: string) => {
      await fireEvent.click(getByText(label, { selector: 'button' }));
      await tick();
    };

    await press('Changed');
    expect(getByText('Changed', { selector: 'button' }).getAttribute('aria-pressed')).toBe('true');
    expect(rowIds(container).sort()).toEqual(
      ['reader.fullscreen', 'set.bold.toggle', 'set.brightness.up'].sort()
    );
    await press('Changed');
    expect(rowIds(container)).toEqual([]);

    await press('On the quick menu');
    const onMenu = rowIds(container);
    expect(onMenu).toHaveLength(9);
    expect(onMenu).toContain('set.brightness.up');
    expect(onMenu).toContain('reader.page-next');
    await press('On the quick menu');

    await press('Has a key');
    const bound = rowIds(container);
    expect(bound).toContain('set.bold.toggle');
    expect(bound).toContain('reader.page-left');
    expect(bound).not.toContain('reader.fullscreen');
    expect(bound).not.toContain('reader.goto-page');
    for (const r of container.querySelectorAll('[data-key-action]')) {
      expect(r.textContent, r.getAttribute('data-key-action')!).not.toContain('Not set');
    }
  });
});

describe('Shortcuts and quick menu: a search mounts a bounded list', () => {
  afterEach(() => vi.useRealTimers());

  it('one letter mounts at most MATCH_LIMIT action rows, says so, and Show all lists the rest', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await search(section, 'e');
    expect(rowIds(container)).toHaveLength(MATCH_LIMIT);
    const more = container.querySelector('[data-key-more]')!;
    const [, shown, total] = /first (\d+) of (\d+) matching/.exec(more.textContent!)!;
    expect(Number(shown)).toBe(MATCH_LIMIT);
    expect(Number(total)).toBeGreaterThan(150);

    await fireEvent.click(more.querySelector('button')!);
    await tick();
    expect(rowIds(container)).toHaveLength(Number(total));
    expect(container.querySelector('[data-key-more]')).toBeNull();

    // "Show all" was for THAT search: the next one is cut again.
    await search(section, 'a');
    expect(rowIds(container)).toHaveLength(MATCH_LIMIT);
    expect(container.querySelector('[data-key-more]')).not.toBeNull();
  });

  it('a search that fits shows everything and no "Show all"', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    await search(section, 'paged zoom');
    expect(rowIds(section.container)).toHaveLength(7);
    expect(section.container.querySelector('[data-key-more]')).toBeNull();
  });

  it('waits for the typing to pause: the keystrokes on the way mount nothing', async () => {
    vi.useFakeTimers();
    const section = render(KeyboardShortcuts, { open: true });
    const { container } = section;
    const box = section.getByLabelText('Search shortcuts') as HTMLInputElement;
    const type = async (text: string) => {
      await fireEvent.input(box, { target: { value: text } });
      await tick();
    };
    await type('t');
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 1);
    expect(box.value).toBe('t');
    expect(rowIds(container)).toEqual([]);
    await type('ti');
    await type('timer');
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 1);
    // Nothing yet — not "t"'s rows, which the first timer would have mounted.
    expect(rowIds(container)).toEqual([]);
    expect(container.querySelectorAll('[data-key-group]')).toHaveLength(GROUP_ORDER.length);
    await vi.advanceTimersByTimeAsync(1);
    expect(rowIds(container)).toEqual(['reader.timer', 'reader.timer-pause']);
    expect(
      container.querySelector('[data-keyboard-shortcuts]')!.getAttribute('data-key-search')
    ).toBe('timer');
    // Clearing the box folds everything away at once.
    await type('');
    expect(rowIds(container)).toEqual([]);
    expect(container.querySelectorAll('[data-key-group]')).toHaveLength(GROUP_ORDER.length);
  });
});

describe('Shortcuts and quick menu: what a search or a filter holds open', () => {
  it('a folded setting’s header is disabled, not a button that says expanded and does nothing', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await search(section, 'brightness');
    const header = settingRow(container, 'brightness')!.querySelector('button')!;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.disabled).toBe(true);
    // Like the group's own header.
    expect((groupButton(container, 'image') as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(header);
    await tick();
    expect(rowIds(container)).toHaveLength(3);

    // Without a search it folds and unfolds again.
    await search(section, '');
    await openGroup(section, 'image');
    const free = settingRow(container, 'brightness')!.querySelector('button')!;
    expect(free.disabled).toBe(false);
    expect(free.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(free);
    await tick();
    expect(free.getAttribute('aria-expanded')).toBe('true');
    expect(rowIds(container)).toContain('set.brightness.up');
  });
});

describe('Shortcuts and quick menu: a row changed under a filter stays', () => {
  const live = (c: Element, id: string) =>
    row(c, id)!.querySelector('[aria-live="polite"]')!.textContent;

  async function press(
    section: { getByText: (text: string, options?: { selector?: string }) => HTMLElement },
    label: string
  ) {
    await fireEvent.click(section.getByText(label, { selector: 'button' }));
    await tick();
  }

  it('Has a key: removing the last key keeps the row, its announcement, and a way back', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await press(section, 'Has a key');
    expect(row(container, 'reader.fullscreen')).not.toBeNull();
    const before = rowIds(container);

    await fireEvent.click(section.getByLabelText('Remove F from Fullscreen'));
    await tick();
    expect(get(settings).keyBindings).toEqual({ 'reader.fullscreen': [] });
    // Still there, in place, saying what happened.
    expect(rowIds(container)).toEqual(before);
    expect(row(container, 'reader.fullscreen')!.textContent).toContain('Not set');
    expect(live(container, 'reader.fullscreen')).toBe('F removed from Fullscreen.');
    // And Reset is right there.
    await fireEvent.click(section.getByText('Reset', { selector: 'button' }));
    await tick();
    expect(get(settings).keyBindings).toEqual({});

    // The filter applied again lists what has a key now.
    await fireEvent.click(section.getByLabelText('Remove F from Fullscreen'));
    await tick();
    await press(section, 'Has a key');
    await press(section, 'Has a key');
    expect(row(container, 'reader.fullscreen')).toBeNull();
  });

  it('Changed: Reset keeps the row; On the quick menu: the switch can be flipped back', async () => {
    updateSetting('keyBindings', { 'reader.fullscreen': ['KeyX'] });
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await press(section, 'Changed');
    expect(rowIds(container)).toEqual(['reader.fullscreen']);
    await fireEvent.click(section.getByText('Reset', { selector: 'button' }));
    await tick();
    expect(get(settings).keyBindings).toEqual({});
    expect(rowIds(container)).toEqual(['reader.fullscreen']);
    expect(live(container, 'reader.fullscreen')).toBe('Fullscreen reset.');
    await press(section, 'Changed');

    await press(section, 'On the quick menu');
    const menuSwitch = () =>
      row(container, 'reader.zoom-fit')!.querySelector(
        '[data-quick-menu-switch]'
      ) as HTMLButtonElement;
    await fireEvent.click(menuSwitch());
    await tick();
    expect(get(settings).quickMenu).toEqual({ 'reader.zoom-fit': false });
    expect(menuSwitch().getAttribute('aria-checked')).toBe('false');
    await fireEvent.click(menuSwitch());
    await tick();
    expect(get(settings).quickMenu).toEqual({});
    expect(menuSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('a search by a key’s label keeps the row whose key was just removed', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await search(section, chordLabel('Home'));
    expect(rowIds(container)).toEqual(['reader.page-first']);
    await fireEvent.click(
      row(container, 'reader.page-first')!.querySelector('[data-key-chip] button')!
    );
    await tick();
    expect(rowIds(container)).toEqual(['reader.page-first']);
    // Typing something else lets it go.
    await search(section, 'timer');
    expect(rowIds(container)).toEqual(['reader.timer', 'reader.timer-pause']);
    await search(section, chordLabel('Home'));
    expect(rowIds(container)).toEqual([]);
  });
});

describe('Shortcuts and quick menu: keys', () => {
  it('a generated action records a key like any other, and conflicts are seen across both kinds', async () => {
    updateSetting('keyBindings', { 'set.bold.toggle': ['KeyF'] });
    const section = render(KeyboardShortcuts, AT_ONCE);
    for (const [query, id] of [
      ['fullscreen', 'reader.fullscreen'],
      ['bold font', 'set.bold.toggle']
    ]) {
      await search(section, query);
      expect(row(section.container, id)!.querySelector(CONFLICT), id).toBeTruthy();
    }
  });

  it('saves edits into the profile; Reset all clears them', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    await openGroup(section, 'view');
    await fireEvent.click(section.getByLabelText('Remove F from Fullscreen'));
    expect(get(settings).keyBindings).toEqual({ 'reader.fullscreen': [] });
    await tick();
    await fireEvent.click(section.getByText('Reset all shortcuts'));
    expect(get(settings).keyBindings).toEqual({});
  });

  it('flags a stored conflict on both rows', async () => {
    updateSetting('keyBindings', { 'reader.fullscreen': ['KeyN'] });
    const section = render(KeyboardShortcuts, AT_ONCE);
    for (const [query, id] of [
      ['fullscreen', 'reader.fullscreen'],
      ['night mode', 'reader.night']
    ]) {
      await search(section, query);
      expect(row(section.container, id)!.querySelector(CONFLICT), id).toBeTruthy();
    }
  });
});

describe('Shortcuts and quick menu: the quick-menu switch', () => {
  const menuSwitch = (c: Element, id: string) =>
    row(c, id)!.querySelector('[data-quick-menu-switch]') as HTMLButtonElement | null;

  it('counts today’s eight at defaults, with no Reset to offer', () => {
    const { container, queryByText } = render(KeyboardShortcuts, AT_ONCE);
    expect(container.querySelector('[data-quick-menu-count]')!.textContent).toContain(
      'Quick menu: 8 actions'
    );
    expect(queryByText('Reset quick menu')).toBeNull();
    expect(queryByText('Reset all shortcuts')).toBeNull();
  });

  it('every row has a switch, except where the action can never be on the menu', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    const all = new Map(allActions().map((a) => [a.id, a]));
    // Four areas, with their folded settings opened: reader actions, the
    // never-on-the-menu wheel list, app actions of both kinds, and two areas
    // from outside the reader.
    let withSwitch = 0;
    let without = 0;
    for (const id of ['navigation', 'app', 'library', 'other']) {
      await openGroup(section, id);
      for (const fold of group(container, id).querySelectorAll('[data-key-setting] > button')) {
        await fireEvent.click(fold);
      }
      await tick();
      const rows = group(container, id).querySelectorAll('[data-key-action]');
      expect(rows.length, id).toBeGreaterThan(4);
      for (const r of rows) {
        const action = all.get(r.getAttribute('data-key-action')!)!;
        const has = !!r.querySelector('[data-quick-menu-switch]');
        expect(has, action.id).toBe(menuEligible(action));
        if (has) withSwitch++;
        else without++;
      }
      await openGroup(section, id);
    }
    expect(withSwitch).toBeGreaterThan(20);
    expect(without).toBeGreaterThan(20);
    expect(group(container, 'library').querySelector('[data-quick-menu-switch]')).toBeNull();
    await search(section, 'quick');
    expect(menuSwitch(container, 'reader.quick-menu')).toBeNull();
    expect(menuSwitch(container, 'set.quick-actions.toggle')).toBeNull();
    await search(section, 'series');
    expect(menuSwitch(container, 'library.series-edit')).toBeNull();
    expect(menuSwitch(container, 'series.edit')).toBeNull();
    await search(section, 'open');
    expect(menuSwitch(container, 'app.open-catalog')).toBeNull();
    expect(menuSwitch(container, 'app.settings')).not.toBeNull();
  });

  it('writes the sparse map: on adds an entry, back to the default deletes it', async () => {
    const section = render(KeyboardShortcuts, AT_ONCE);
    const { container } = section;
    await search(section, 'bold');
    const bold = () => menuSwitch(container, 'set.bold.toggle')!;
    expect(bold().getAttribute('role')).toBe('switch');
    expect(bold().getAttribute('aria-checked')).toBe('false');
    expect(bold().getAttribute('aria-label')).toBe('Show Bold font on the quick menu');
    await fireEvent.click(bold());
    await tick();
    expect(get(settings).quickMenu).toEqual({ 'set.bold.toggle': true });
    expect(bold().getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-quick-menu-count]')!.textContent).toContain(
      'Quick menu: 9 actions'
    );
    await fireEvent.click(bold());
    await tick();
    expect(get(settings).quickMenu).toEqual({});

    // A default: off stores `false`, on again deletes it.
    await search(section, 'fullscreen');
    const full = () => menuSwitch(container, 'reader.fullscreen')!;
    expect(full().getAttribute('aria-checked')).toBe('true');
    await fireEvent.click(full());
    await tick();
    expect(get(settings).quickMenu).toEqual({ 'reader.fullscreen': false });
    expect(container.querySelector('[data-quick-menu-count]')!.textContent).toContain(
      'Quick menu: 7 actions'
    );
    await fireEvent.click(full());
    await tick();
    expect(get(settings).quickMenu).toEqual({});
  });

  it('Reset quick menu and Reset all shortcuts are separate', async () => {
    updateSetting('keyBindings', { 'reader.fullscreen': ['KeyX'] });
    updateSetting('quickMenu', { 'set.bold.toggle': true, 'reader.fullscreen': false });
    const section = render(KeyboardShortcuts, AT_ONCE);
    await tick();
    await fireEvent.click(section.getByText('Reset quick menu'));
    await tick();
    expect(get(settings).quickMenu).toEqual({});
    expect(get(settings).keyBindings).toEqual({ 'reader.fullscreen': ['KeyX'] });
    expect(section.queryByText('Reset quick menu')).toBeNull();

    updateSetting('quickMenu', { 'set.bold.toggle': true });
    await tick();
    await fireEvent.click(section.getByText('Reset all shortcuts'));
    expect(get(settings).keyBindings).toEqual({});
    expect(get(settings).quickMenu).toEqual({ 'set.bold.toggle': true });
  });

  it('Copy to all profiles writes both maps into every profile', async () => {
    createProfile('KeysCopyTarget');
    updateSetting('keyBindings', { 'reader.page-right': ['ArrowRight', 'KeyD'] });
    updateSetting('quickMenu', { 'set.bold.toggle': true });
    const { getByText } = render(KeyboardShortcuts, AT_ONCE);
    await fireEvent.click(getByText('Copy to all profiles'));
    for (const p of Object.values(get(profiles))) {
      expect(p.keyBindings).toEqual({ 'reader.page-right': ['ArrowRight', 'KeyD'] });
      expect(p.quickMenu).toEqual({ 'set.bold.toggle': true });
    }
  });
});

describe('Shortcuts and quick menu: touch', () => {
  it('says keys need a keyboard and the quick menu does not; the switches still work', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' }));
    const section = render(KeyboardShortcuts, AT_ONCE);
    expect(section.container.querySelector('[data-touch-note]')!.textContent!.trim()).toBe(
      'Keys need a hardware keyboard. The quick menu works by touch.'
    );
    await search(section, 'bold');
    await fireEvent.click(
      row(section.container, 'set.bold.toggle')!.querySelector('[data-quick-menu-switch]')!
    );
    expect(get(settings).quickMenu).toEqual({ 'set.bold.toggle': true });
  });

  it('shows no note on a device with a keyboard and mouse', () => {
    const { container } = render(KeyboardShortcuts, AT_ONCE);
    expect(container.querySelector('[data-touch-note]')).toBeNull();
  });
});
