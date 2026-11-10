import { describe, expect, it } from 'vitest';
import type { KeyActionDef } from './actions';
import {
  QUICK_MENU_DEFAULT,
  isMenuChanged,
  isOnMenu,
  menuBadge,
  menuEligible,
  quickMenuIds,
  quickMenuItems,
  sanitizeQuickMenu,
  withQuickMenu,
  type QuickMenuState
} from './quick-menu';
import { allActions } from './registry';

const all = allActions();
const byId = new Map(all.map((a) => [a.id, a]));
const def = (id: string) => {
  const found = byId.get(id);
  if (!found) throw new Error(`no action ${id}`);
  return found;
};

const TODAY = [
  'reader.ocr-layers',
  'reader.edit-mode',
  'reader.anki-image',
  'reader.anki-image-2',
  'reader.fullscreen',
  'reader.zoom-fit',
  'reader.page-right',
  'reader.page-left'
];

describe('the default quick menu', () => {
  it('is today’s eight, top to bottom, and every one is a real, eligible action', () => {
    expect([...QUICK_MENU_DEFAULT]).toEqual(TODAY);
    for (const id of QUICK_MENU_DEFAULT) expect(menuEligible(def(id)), id).toBe(true);
  });

  it('{} and a missing map both give today’s menu in today’s order', () => {
    expect(quickMenuIds({}, all)).toEqual(TODAY);
    expect(quickMenuIds(undefined, all)).toEqual(TODAY);
  });
});

describe('eligibility', () => {
  it('is the reader, edit mode and the app, minus the ones marked never', () => {
    expect(menuEligible(def('set.bold.toggle'))).toBe(true);
    expect(menuEligible(def('edit.undo'))).toBe(true);
    expect(menuEligible(def('app.settings'))).toBe(true);
    expect(menuEligible(def('reader.quick-menu'))).toBe(false);
    expect(menuEligible(def('set.quick-actions.toggle'))).toBe(false);
    expect(menuEligible(def('set.wheel.next'))).toBe(false);
    expect(menuEligible(def('app.open-catalog'))).toBe(false);
    expect(menuEligible(def('library.series-edit'))).toBe(false);
    expect(menuEligible(def('series.edit'))).toBe(false);
    expect(menuEligible(def('text.copy'))).toBe(false);
  });

  it('holds whatever the action says: a library action marked off is still not eligible', () => {
    const odd = { ...def('library.focus-search'), menu: 'off' } as KeyActionDef;
    expect(menuEligible(odd)).toBe(false);
    expect(quickMenuIds({ [odd.id]: true }, [...all.filter((a) => a.id !== odd.id), odd])).toEqual(
      TODAY
    );
  });
});

describe('sparse edits', () => {
  it('false hides a default; the rest keep their order', () => {
    const menu = { 'reader.fullscreen': false, 'reader.anki-image-2': false };
    expect(quickMenuIds(menu, all)).toEqual(
      TODAY.filter((id) => id !== 'reader.fullscreen' && id !== 'reader.anki-image-2')
    );
  });

  it('additions follow the defaults, in registry order whatever order they were added in', () => {
    const menu = { 'set.bold.toggle': true, 'reader.page-next': true, 'app.settings': true };
    const ids = quickMenuIds(menu, all);
    expect(ids.slice(0, 8)).toEqual(TODAY);
    const added = ids.slice(8);
    expect(added).toEqual(
      all
        .map((a) => a.id)
        .filter((id) => ['set.bold.toggle', 'reader.page-next', 'app.settings'].includes(id))
    );
    expect(added).toEqual(['reader.page-next', 'app.settings', 'set.bold.toggle']);
  });

  it('true on a default changes nothing; unknown ids and never ids are ignored', () => {
    const menu = {
      'reader.fullscreen': true,
      'not.an.action': true,
      'reader.quick-menu': true,
      'set.wheel.to.turn': true,
      'library.series-edit': true
    };
    expect(quickMenuIds(menu, all)).toEqual(TODAY);
  });

  it('the writer returns a new map and deletes an entry that equals the default', () => {
    const start = {};
    const added = withQuickMenu(start, def('set.bold.toggle'), true);
    expect(added).toEqual({ 'set.bold.toggle': true });
    expect(start).toEqual({});
    expect(withQuickMenu(added, def('set.bold.toggle'), false)).toEqual({});

    const hidden = withQuickMenu({}, def('reader.fullscreen'), false);
    expect(hidden).toEqual({ 'reader.fullscreen': false });
    expect(withQuickMenu(hidden, def('reader.fullscreen'), true)).toEqual({});
    // A stored value that merely repeats the default goes too.
    expect(withQuickMenu({ 'reader.fullscreen': true }, def('reader.fullscreen'), true)).toEqual(
      {}
    );
  });

  it('the writer leaves other entries alone, unknown ids included, and refuses a never id', () => {
    const start = { 'from.a.newer.client': true, 'reader.fullscreen': false };
    expect(withQuickMenu(start, def('set.bold.toggle'), true)).toEqual({
      ...start,
      'set.bold.toggle': true
    });
    expect(withQuickMenu(start, def('reader.quick-menu'), true)).toEqual(start);
  });

  it('isOnMenu and isMenuChanged read the same sparse map', () => {
    const menu = { 'reader.fullscreen': false, 'set.bold.toggle': true, 'reader.zoom-fit': true };
    expect(isOnMenu(menu, def('reader.fullscreen'))).toBe(false);
    expect(isOnMenu(menu, def('set.bold.toggle'))).toBe(true);
    expect(isOnMenu(menu, def('reader.page-left'))).toBe(true);
    expect(isOnMenu(menu, def('set.ocr.toggle'))).toBe(false);
    expect(isOnMenu({ 'reader.quick-menu': true }, def('reader.quick-menu'))).toBe(false);
    expect(isMenuChanged(menu, def('reader.fullscreen'))).toBe(true);
    expect(isMenuChanged(menu, def('set.bold.toggle'))).toBe(true);
    // Stored, but equal to the default: not a change.
    expect(isMenuChanged(menu, def('reader.zoom-fit'))).toBe(false);
    expect(isMenuChanged(menu, def('reader.page-left'))).toBe(false);
  });

  it('the shape check keeps booleans, unknown ids included, and drops the rest', () => {
    expect(sanitizeQuickMenu({ a: true, b: false, c: 'yes', d: 1, e: null })).toEqual({
      a: true,
      b: false
    });
    expect(sanitizeQuickMenu([true])).toEqual({});
    expect(sanitizeQuickMenu('x')).toEqual({});
  });
});

describe('the mode filter', () => {
  const menu = {
    'set.zoom-paged.next': true,
    'set.zoom-continuous.next': true,
    'edit.undo': true,
    'reader.scroll-left': true
  };

  it('keeps only what is live in the layout', () => {
    const paged = quickMenuIds(menu, all, 'paged');
    expect(paged).toContain('set.zoom-paged.next');
    expect(paged).toContain('edit.undo');
    expect(paged).not.toContain('set.zoom-continuous.next');
    expect(paged).not.toContain('reader.scroll-left');
    expect(paged).toContain('reader.page-left');

    const vertical = quickMenuIds(menu, all, 'vertical');
    expect(vertical).toContain('set.zoom-continuous.next');
    expect(vertical).toContain('reader.scroll-left');
    expect(vertical).not.toContain('set.zoom-paged.next');
    expect(vertical).not.toContain('edit.undo');
    // Page left and right are not vertical scroll's keys, so not its buttons either.
    expect(vertical).not.toContain('reader.page-left');
    expect(vertical).not.toContain('reader.page-right');
    expect(vertical).toContain('reader.edit-mode');

    const horizontal = quickMenuIds(menu, all, 'horizontal');
    expect(horizontal).toContain('reader.page-left');
    expect(horizontal).not.toContain('reader.scroll-left');
  });
});

describe('badges', () => {
  it('tell apart the actions that share an icon', () => {
    expect(menuBadge(def('set.brightness.up'))).toBe('+');
    expect(menuBadge(def('set.brightness.down'))).toBe('−');
    expect(menuBadge(def('set.brightness.reset'))).toBe('0');
    expect(menuBadge(def('set.zoom-paged.next'))).toBe('›');
    expect(menuBadge(def('set.zoom-paged.prev'))).toBe('‹');
    expect(menuBadge(def('set.zoom-paged.to.zoomFitToWidth'))).toBe('Fit');
    expect(menuBadge(def('set.font-size.to.9'))).toBe('9');
    expect(menuBadge(def('set.font-size.to.auto'))).toBe(
      def('set.font-size.to.auto').option!.slice(0, 3)
    );
    expect(menuBadge(def('set.font-size.to.auto'))).toHaveLength(3);
    expect(menuBadge(def('set.bold.toggle'))).toBeUndefined();
    expect(menuBadge(def('reader.fullscreen'))).toBeUndefined();
    expect(menuBadge(def('reader.ocr-layer-prev'))).toBe('‹');
    expect(menuBadge(def('reader.ocr-layer'))).toBe('›');
  });
});

describe('the menu items', () => {
  const base: QuickMenuState = {
    mode: 'paged',
    editing: false,
    ankiEnabled: true,
    hasSecondPage: true,
    hasLayers: true,
    toggleOn: () => undefined
  };
  const items = (menu: Record<string, boolean>, state: Partial<QuickMenuState> = {}) =>
    quickMenuItems(quickMenuIds(menu, all, state.mode ?? base.mode), byId, { ...base, ...state });
  const ids = (list: ReturnType<typeof items>) => list.map((i) => i.id);

  it('carry the action’s label and icon, today’s Anki badges, and nothing disabled', () => {
    const list = items({});
    expect(ids(list)).toEqual(TODAY);
    for (const item of list) {
      expect(item.label, item.id).toBe(def(item.id).label);
      expect(item.icon, item.id).toBe(def(item.id).icon);
      expect(item.disabled, item.id).toBeUndefined();
    }
    const badge = (id: string) => list.find((i) => i.id === id)?.badge;
    expect(badge('reader.anki-image')).toBe('1');
    expect(badge('reader.anki-image-2')).toBe('2');
    expect(badge('reader.fullscreen')).toBeUndefined();
  });

  it('hide the Anki pair with AnkiConnect off, and the second with one page on screen', () => {
    expect(ids(items({}, { ankiEnabled: false }))).toEqual(
      TODAY.filter((id) => !id.startsWith('reader.anki-image'))
    );
    const single = items({}, { hasSecondPage: false });
    expect(ids(single)).toEqual(TODAY.filter((id) => id !== 'reader.anki-image-2'));
    // One page: no "1" either, as today.
    expect(single.find((i) => i.id === 'reader.anki-image')?.badge).toBeUndefined();
  });

  it('hide the layer picker with no layers, unless editing', () => {
    expect(ids(items({}, { hasLayers: false }))).not.toContain('reader.ocr-layers');
    expect(ids(items({}, { hasLayers: false, editing: true }))).toContain('reader.ocr-layers');
  });

  it('disable Edit with the reason: continuous scroll, the read-only original', () => {
    const edit = (state: Partial<QuickMenuState>) =>
      items({}, state).find((i) => i.id === 'reader.edit-mode')!;
    expect(edit({}).disabled).toBeUndefined();
    expect(edit({ mode: 'vertical' }).disabled).toBe('Edit is available in paged mode only');
    expect(edit({ editBlocked: 'The original layer is read-only' }).disabled).toBe(
      'The original layer is read-only'
    );
    expect(edit({ editing: true }).active).toBe(true);
    expect(edit({}).active).toBe(false);
  });

  it('disable edit commands outside edit mode, and enable them inside it', () => {
    const menu = { 'edit.undo': true, 'edit.merge': true };
    const outside = items(menu);
    expect(outside.find((i) => i.id === 'edit.undo')?.disabled).toBe('Only in edit mode');
    expect(outside.find((i) => i.id === 'edit.merge')?.disabled).toBe('Only in edit mode');
    const inside = items(menu, { editing: true });
    expect(inside.find((i) => i.id === 'edit.undo')?.disabled).toBeUndefined();
    // Not live in continuous scroll at all: gone, not greyed.
    expect(ids(items(menu, { mode: 'vertical' }))).not.toContain('edit.undo');
  });

  it('show a toggle’s state and a stepping action’s badge', () => {
    const menu = {
      'set.bold.toggle': true,
      'reader.night': true,
      'set.brightness.up': true,
      'set.brightness.down': true,
      'set.zoom-paged.to.zoomFitToWidth': true
    };
    const list = items(menu, {
      toggleOn: (action) =>
        action.setting?.op === 'toggle' ? action.id === 'reader.night' : undefined
    });
    const item = (id: string) => list.find((i) => i.id === id)!;
    expect(item('reader.night').active).toBe(true);
    expect(item('set.bold.toggle').active).toBe(false);
    expect(item('set.brightness.up').active).toBeUndefined();
    expect(item('set.brightness.up').badge).toBe('+');
    expect(item('set.brightness.down').badge).toBe('−');
    expect(item('set.zoom-paged.to.zoomFitToWidth').badge).toBe('Fit');
    // A step keeps the menu open for the next tap; anything else closes it.
    expect(item('set.brightness.up').keepOpen).toBe(true);
    expect(item('set.bold.toggle').keepOpen).toBe(false);
    expect(list.find((i) => i.id === 'reader.page-left')?.keepOpen).toBe(false);
  });
});
