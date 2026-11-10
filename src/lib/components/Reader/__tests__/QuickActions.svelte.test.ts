import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';

vi.mock('$lib/catalog/db', () => ({ db: {} }));

import QuickActions from '../QuickActions.svelte';
import {
  quickMenuIds,
  quickMenuItems,
  type QuickMenuSelection,
  type QuickMenuState
} from '$lib/keys/quick-menu';
import { allActions } from '$lib/keys/registry';

afterEach(cleanup);

const layers = [
  { layer_id: 'english', name: 'English', kind: 'translation' as const, updated_at: 'x' }
];

const ACTIONS = new Map(allActions().map((a) => [a.id, a]));

/** The entries the reader would hand the menu for a profile's selection and its own state. */
function entries(menu: QuickMenuSelection = {}, state: Partial<QuickMenuState> = {}) {
  const full: QuickMenuState = {
    mode: 'paged',
    forward: 'left',
    editing: false,
    ankiEnabled: true,
    hasSecondPage: true,
    hasLayers: true,
    toggleOn: () => undefined,
    ...state
  };
  return quickMenuItems(quickMenuIds(menu, ACTIONS.values(), full.mode), ACTIONS, full);
}

/** Mounts QuickActions with `layersOpen` and `open` bound to parent-owned `$state`, as Reader does. */
function mount(
  initial: { visible?: boolean; items?: ReturnType<typeof entries>; open?: boolean } = {}
) {
  const parent = $state({
    layersOpen: false,
    open: initial.open ?? false,
    visible: initial.visible ?? true,
    items: initial.items ?? entries()
  });
  // The reader's `runAction`: the layer picker's action opens the picker.
  const onRun = vi.fn((id: string) => {
    if (id === 'reader.ocr-layers') parent.layersOpen = true;
  });
  const utils = render(QuickActions, {
    props: {
      onRun,
      layers,
      onSelectLayer: vi.fn(),
      onLayerAction: vi.fn(),
      get items() {
        return parent.items;
      },
      get visible() {
        return parent.visible;
      },
      get layersOpen() {
        return parent.layersOpen;
      },
      set layersOpen(v: boolean) {
        parent.layersOpen = v;
      },
      get open() {
        return parent.open;
      },
      set open(v: boolean) {
        parent.open = v;
      }
    }
  });
  const shown = () =>
    [...utils.container.querySelectorAll('[data-quick-action]')].map((el) =>
      el.getAttribute('data-quick-action')
    );
  return { parent, onRun, shown, ...utils };
}

async function openPicker(utils: ReturnType<typeof mount>) {
  await fireEvent.click(utils.getByLabelText('Quick actions menu'));
  await fireEvent.click(utils.getByLabelText('OCR layers'));
  expect(utils.parent.layersOpen).toBe(true);
}

describe('QuickActions — layer picker open state', () => {
  it('publishes the picker open state to the parent, which can close it (Escape path)', async () => {
    const utils = mount();
    await openPicker(utils);
    expect(utils.queryByRole('dialog', { name: 'OCR layers' })).not.toBeNull();

    utils.parent.layersOpen = false;
    flushSync();
    expect(utils.queryByRole('dialog', { name: 'OCR layers' })).toBeNull();
  });

  it('reports closed once the picker is no longer rendered (overlays hidden)', async () => {
    // Otherwise the reader would keep swallowing its shortcuts for a picker
    // nobody can see.
    const utils = mount();
    await openPicker(utils);
    utils.parent.visible = false;
    flushSync();
    expect(utils.parent.layersOpen).toBe(false);
  });

  it('reports closed when it unmounts with the picker open (volume switch)', async () => {
    const utils = mount();
    await openPicker(utils);
    utils.unmount();
    expect(utils.parent.layersOpen).toBe(false);
  });
});

describe('QuickActions — opened by a key (#55)', () => {
  it('publishes the menu open state, and a parent (the key) can open and close it', async () => {
    const utils = mount();
    expect(utils.queryByLabelText('Zoom to fit')).toBeNull();
    utils.parent.open = true;
    flushSync();
    expect(utils.queryByLabelText('Zoom to fit')).not.toBeNull();
    utils.parent.open = false;
    flushSync();
    expect(utils.queryByLabelText('Zoom to fit')).toBeNull();
    // The button toggles the same state.
    await fireEvent.click(utils.getByLabelText('Quick actions menu'));
    expect(utils.parent.open).toBe(true);
  });

  it('opens by key while its button is hidden, and brings the button along to close it', async () => {
    const utils = mount({ visible: false });
    expect(utils.queryByLabelText('Quick actions menu')).toBeNull();
    utils.parent.open = true;
    flushSync();
    expect(utils.queryByLabelText('Zoom to fit')).not.toBeNull();
    await fireEvent.click(utils.getByLabelText('Quick actions menu'));
    expect(utils.parent.open).toBe(false);
    expect(utils.queryByLabelText('Quick actions menu')).toBeNull();
  });

  it('renders the layer picker whenever it is open, not only while the menu button shows', () => {
    const utils = mount({ visible: false });
    utils.parent.layersOpen = true;
    flushSync();
    expect(utils.queryByRole('dialog', { name: 'OCR layers' })).not.toBeNull();
    // Nothing else of the menu came with it.
    expect(utils.queryByLabelText('Quick actions menu')).toBeNull();
    expect(utils.parent.layersOpen).toBe(true);
  });

  it('hiding the controls puts an open menu away too', () => {
    const utils = mount();
    utils.parent.open = true;
    flushSync();
    utils.parent.visible = false;
    flushSync();
    expect(utils.parent.open).toBe(false);
    expect(utils.queryByLabelText('Quick actions menu')).toBeNull();
  });

  it("Zoom to fit runs the reader's handler — the key's — and closes the menu", async () => {
    const utils = mount();
    utils.parent.open = true;
    flushSync();
    await fireEvent.click(utils.getByLabelText('Zoom to fit'));
    expect(utils.onRun).toHaveBeenCalledExactlyOnceWith('reader.zoom-fit');
    expect(utils.parent.open).toBe(false);
  });
});

describe('QuickActions — drawn from the registry (#55 step C)', () => {
  it('at defaults shows today’s eight, top to bottom, named by their actions', () => {
    const utils = mount({ open: true });
    expect(utils.shown()).toEqual([
      'reader.ocr-layers',
      'reader.edit-mode',
      'reader.anki-image',
      'reader.anki-image-2',
      'reader.fullscreen',
      'reader.zoom-fit',
      'reader.page-next',
      'reader.page-prev'
    ]);
    for (const id of utils.shown()) {
      const button = utils.container.querySelector(`[data-quick-action="${id}"]`)!;
      const label = ACTIONS.get(id!)!.label;
      expect(button.getAttribute('aria-label'), id!).toBe(label);
      expect(button.getAttribute('title'), id!).toBe(label);
      expect(button.querySelector('svg'), id!).not.toBeNull();
    }
    // The Anki pair keeps its numbers; nothing else is badged.
    const badge = (id: string) =>
      utils.container
        .querySelector(`[data-quick-action="${id}"] [data-quick-action-badge]`)
        ?.textContent?.trim();
    expect(badge('reader.anki-image')).toBe('1');
    expect(badge('reader.anki-image-2')).toBe('2');
    expect(badge('reader.fullscreen')).toBeUndefined();
  });

  it('every entry runs its action id through the one handler', async () => {
    const utils = mount({ open: true });
    for (const id of utils.shown()) {
      utils.parent.open = true;
      flushSync();
      await fireEvent.click(utils.container.querySelector(`[data-quick-action="${id}"]`)!);
      expect(utils.onRun).toHaveBeenLastCalledWith(id);
      expect(utils.parent.open, id!).toBe(false);
    }
    expect(utils.onRun).toHaveBeenCalledTimes(8);
  });

  it('draws additions after the defaults with their badges, and keeps a step’s menu open', async () => {
    const items = entries({
      'set.brightness.up': true,
      'set.brightness.down': true,
      'set.brightness.reset': true,
      'set.zoom-paged.next': true,
      'set.zoom-paged.to.zoomFitToWidth': true,
      'reader.fullscreen': false
    });
    const utils = mount({ open: true, items });
    const shown = utils.shown();
    expect(shown).not.toContain('reader.fullscreen');
    expect(shown.slice(0, 7)).toEqual([
      'reader.ocr-layers',
      'reader.edit-mode',
      'reader.anki-image',
      'reader.anki-image-2',
      'reader.zoom-fit',
      'reader.page-next',
      'reader.page-prev'
    ]);
    const badge = (id: string) =>
      utils.container
        .querySelector(`[data-quick-action="${id}"] [data-quick-action-badge]`)
        ?.textContent?.trim();
    expect(badge('set.brightness.up')).toBe('+');
    expect(badge('set.brightness.down')).toBe('−');
    expect(badge('set.brightness.reset')).toBe('0');
    expect(badge('set.zoom-paged.next')).toBe('›');
    expect(badge('set.zoom-paged.to.zoomFitToWidth')).toBe('Fit');

    await fireEvent.click(utils.getByLabelText('Brightness: Step up'));
    expect(utils.onRun).toHaveBeenLastCalledWith('set.brightness.up');
    expect(utils.parent.open).toBe(true);
    await fireEvent.click(utils.getByLabelText('Brightness: Reset'));
    expect(utils.parent.open).toBe(false);
  });

  it('disables an entry with its reason as the tooltip, and does not run it', async () => {
    const items = entries(
      { 'edit.undo': true },
      { editBlocked: 'The original layer is read-only' }
    );
    const utils = mount({ open: true, items });
    const edit = utils.getByLabelText('Edit OCR text') as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe('The original layer is read-only');
    const undo = utils.getByLabelText('Undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    expect(undo.title).toBe('Only in edit mode');
    await fireEvent.click(edit);
    await fireEvent.click(undo);
    expect(utils.onRun).not.toHaveBeenCalled();

    // Continuous scroll: Edit says why, the edit command is gone.
    utils.parent.items = entries({ 'edit.undo': true }, { mode: 'vertical' });
    flushSync();
    expect((utils.getByLabelText('Edit OCR text') as HTMLButtonElement).title).toBe(
      'Edit is available in paged mode only'
    );
    expect(utils.queryByLabelText('Undo')).toBeNull();
  });

  it('shows a toggle as pressed, and leaves a plain command without a pressed state', () => {
    const items = entries(
      { 'reader.night': true, 'set.bold.toggle': true },
      {
        editing: true,
        toggleOn: (a) => (a.setting?.op === 'toggle' ? a.id === 'reader.night' : undefined)
      }
    );
    const utils = mount({ open: true, items });
    const pressed = (label: string) => utils.getByLabelText(label).getAttribute('aria-pressed');
    expect(pressed('Night mode')).toBe('true');
    expect(pressed('Bold font')).toBe('false');
    expect(pressed('Edit OCR text')).toBe('true');
    expect(pressed('Fullscreen')).toBeNull();
  });

  it('leaves out what has nothing to act on: Anki off, one page, no layers', () => {
    const utils = mount({
      open: true,
      items: entries({}, { ankiEnabled: false, hasLayers: false })
    });
    expect(utils.shown()).toEqual([
      'reader.edit-mode',
      'reader.fullscreen',
      'reader.zoom-fit',
      'reader.page-next',
      'reader.page-prev'
    ]);
    utils.parent.items = entries({}, { hasSecondPage: false });
    flushSync();
    expect(utils.shown()).not.toContain('reader.anki-image-2');
    expect(
      utils.container.querySelector(
        '[data-quick-action="reader.anki-image"] [data-quick-action-badge]'
      )
    ).toBeNull();
  });

  it('the layer picker entry runs its action, which opens the anchored picker', async () => {
    const utils = mount({ open: true });
    await fireEvent.click(utils.getByLabelText('OCR layers'));
    expect(utils.onRun).toHaveBeenLastCalledWith('reader.ocr-layers');
    flushSync();
    expect(utils.parent.layersOpen).toBe(true);
    expect(utils.queryByRole('dialog', { name: 'OCR layers' })).not.toBeNull();
    expect(utils.parent.open).toBe(false);
  });
});
