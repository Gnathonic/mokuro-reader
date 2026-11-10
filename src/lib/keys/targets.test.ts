import { describe, expect, it } from 'vitest';
import { findSettingDef } from '$lib/settings/setting-defs';
import { GROUP_LABELS, GROUP_ORDER, type ActionId, type KeyActionDef } from './actions';
import { compileKeymap, findConflicts, isModified, type KeyBindings } from './keymap';
import { isMenuChanged, quickMenuIds, type QuickMenuSelection } from './quick-menu';
import { allActions } from './registry';
import {
  buildTargets,
  foldedSummary,
  groupTargets,
  isFiltering,
  labelWithin,
  NO_FILTER,
  type TargetFacts
} from './targets';

const all = allActions();
const targets = buildTargets(all, (id) => findSettingDef(id)?.label);
const target = (key: string) => {
  const found = targets.find((t) => t.key === key);
  if (!found) throw new Error(`no target ${key}`);
  return found;
};

/** The facts as the section derives them. */
function facts(bindings: KeyBindings = {}, quickMenu: QuickMenuSelection = {}): TargetFacts {
  const keymap = compileKeymap(bindings, all);
  return {
    chords: keymap.chords,
    labelOf: (chord) => chord.replace('Key', ''),
    keysChanged: new Set(all.filter((a) => isModified(a, bindings)).map((a) => a.id)),
    onMenu: new Set(quickMenuIds(quickMenu, all)),
    menuChanged: new Set(all.filter((a) => isMenuChanged(quickMenu, a)).map((a) => a.id)),
    conflicts: findConflicts(keymap)
  };
}

const rowsOf = (groups: ReturnType<typeof groupTargets>) => groups.flatMap((g) => g.rows);
const shownIds = (groups: ReturnType<typeof groupTargets>) =>
  rowsOf(groups).flatMap((r) => r.actions.map((a) => a.id));

describe('targets', () => {
  it('are one per command or toggle and one per list or slider: about 130 for 250 actions', () => {
    const hand = all.filter((a) => !a.setting).length;
    const toggles = all.filter((a) => a.setting?.op === 'toggle').length;
    const folded = new Set(all.flatMap((a) => (a.parent ? [a.parent] : []))).size;
    expect(targets).toHaveLength(hand + toggles + folded);
    expect(targets.length).toBeGreaterThan(120);
    expect(targets.length).toBeLessThan(140);
    expect(all.length).toBeGreaterThan(240);
    // Every action is under exactly one target.
    const listed = targets.flatMap((t) => t.actions.map((a) => a.id));
    expect(listed.sort()).toEqual(all.map((a) => a.id).sort());
  });

  it('a list folds Next, Previous and each Set-to; a slider its three; a toggle is its own row', () => {
    const zoom = target('setting:zoom-paged');
    expect(zoom).toMatchObject({ label: 'Paged zoom', folded: true, group: 'view' });
    expect(zoom.actions.map((a) => labelWithin(zoom, a))).toEqual([
      'Next',
      'Previous',
      'Set to Fit to screen',
      'Set to Fit to width',
      'Set to Fill screen',
      'Set to Original size',
      'Set to Keep zoom'
    ]);
    const brightness = target('setting:brightness');
    expect(brightness.actions.map((a) => labelWithin(brightness, a))).toEqual([
      'Step up',
      'Step down',
      'Reset'
    ]);
    const bold = target('set.bold.toggle');
    expect(bold).toMatchObject({ label: 'Bold font', folded: false });
    expect(labelWithin(bold, bold.actions[0])).toBe('Bold font');
    expect(target('reader.night').folded).toBe(false);
    expect(target('reader.fullscreen').actions).toHaveLength(1);
  });

  it('keep registry order, a folded setting where its first action stands', () => {
    const keys = targets.map((t) => t.key);
    expect(keys.indexOf('reader.page-left')).toBe(0);
    expect(keys.indexOf('setting:page-view')).toBeGreaterThan(keys.indexOf('reader.continuous'));
    expect(keys.indexOf('setting:page-view')).toBeLessThan(keys.indexOf('setting:scroll-mode'));
  });
});

describe('groups', () => {
  it('follow the target list’s areas, in its order, and hold every row', () => {
    const groups = groupTargets(targets, facts());
    expect(groups.map((g) => g.group)).toEqual([...GROUP_ORDER]);
    expect(groups.map((g) => g.label)).toEqual([
      'Reader: navigation',
      'Reader: view',
      'Reader: image',
      'Reader: text',
      'Reader: this volume',
      'Reader: edit mode',
      'Reader: OCR layers',
      'App',
      'Library',
      'Series page',
      'Volume row',
      'Series editor',
      'Other views'
    ]);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(targets.length);
    for (const g of groups) {
      expect(g.rows.length, g.group).toBe(g.count);
      expect(g.changed, g.group).toBe(0);
      expect(g.conflict, g.group).toBe(false);
      expect(g.label).toBe(GROUP_LABELS[g.group]);
    }
  });

  it('put each action where the list has it', () => {
    const groups = groupTargets(targets, facts());
    const areaOf = (id: string) =>
      groups.find((g) => g.rows.some((r) => r.actions.some((a) => a.id === id)))?.group;
    expect(areaOf('reader.page-next')).toBe('navigation');
    expect(areaOf('set.wheel.next')).toBe('navigation');
    expect(areaOf('reader.fullscreen')).toBe('view');
    expect(areaOf('reader.continuous')).toBe('view');
    expect(areaOf('reader.night')).toBe('image');
    expect(areaOf('set.brightness.up')).toBe('image');
    expect(areaOf('reader.ocr-always')).toBe('text');
    expect(areaOf('reader.anki-image')).toBe('text');
    expect(areaOf('set.rtl.toggle')).toBe('volume');
    expect(areaOf('reader.offset-spreads')).toBe('volume');
    expect(areaOf('reader.ocr-layer')).toBe('volume');
    expect(areaOf('reader.edit-mode')).toBe('edit');
    expect(areaOf('edit.undo')).toBe('edit');
    expect(areaOf('layer.delete')).toBe('layers');
    expect(areaOf('app.back')).toBe('app');
    expect(areaOf('set.theme.next')).toBe('app');
    expect(areaOf('library.series-edit')).toBe('library');
    expect(areaOf('series.edit')).toBe('series');
    expect(areaOf('library.volume-edit')).toBe('volume-row');
    expect(areaOf('series-editor.next-unlinked')).toBe('series-editor');
    expect(areaOf('tracker.current-period')).toBe('other');
    expect(areaOf('text.copy')).toBe('other');
  });

  it('count the changed rows and carry a conflict up to the group', () => {
    const f = facts(
      { 'set.zoom-paged.next': ['KeyF'], 'reader.page-left': ['ArrowLeft', 'KeyA'] },
      { 'set.bold.toggle': true }
    );
    const groups = groupTargets(targets, f);
    const group = (id: string) => groups.find((g) => g.group === id)!;
    // F is Fullscreen's too: a conflict on both, in one group here.
    expect(group('view').conflict).toBe(true);
    expect(group('view').changed).toBe(1);
    expect(group('navigation').changed).toBe(1);
    expect(group('navigation').conflict).toBe(false);
    expect(group('text').changed).toBe(1);
    expect(group('image').changed).toBe(0);
    const zoom = group('view').rows.find((r) => r.target.key === 'setting:zoom-paged')!;
    expect(zoom).toMatchObject({ conflict: true, changed: true, keys: 1, onMenu: 0 });
    expect(zoom.summary).toBe('7 actions · 1 key');
  });
});

describe('a folded setting’s summary', () => {
  it('says what is inside, so nothing bound is invisible', () => {
    expect(foldedSummary(7, 0, 0)).toBe('7 actions');
    expect(foldedSummary(7, 2, 1)).toBe('7 actions · 2 keys · 1 on the quick menu');
    expect(foldedSummary(3, 1, 0)).toBe('3 actions · 1 key');
    expect(foldedSummary(3, 0, 2)).toBe('3 actions · 2 on the quick menu');
    const f = facts(
      { 'set.brightness.up': ['BracketRight'], 'set.brightness.down': ['BracketLeft'] },
      { 'set.brightness.reset': true }
    );
    const row = rowsOf(groupTargets(targets, f)).find(
      (r) => r.target.key === 'setting:brightness'
    )!;
    expect(row.summary).toBe('3 actions · 2 keys · 1 on the quick menu');
    // A command row has none.
    expect(
      rowsOf(groupTargets(targets, f)).find((r) => r.target.key === 'reader.fullscreen')!.summary
    ).toBe('');
  });
});

describe('search', () => {
  const search = (query: string, f = facts()) => groupTargets(targets, f, { ...NO_FILTER, query });

  it('is off for an empty query and no filter', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering({ ...NO_FILTER, query: '  ' })).toBe(false);
    expect(isFiltering({ ...NO_FILTER, query: 'a' })).toBe(true);
    expect(isFiltering({ ...NO_FILTER, onMenu: true })).toBe(true);
  });

  it('finds an action by its label, hiding the rest', () => {
    expect(shownIds(search('timer'))).toEqual(['reader.timer', 'reader.timer-pause']);
    expect(search('timer').map((g) => g.group)).toEqual(['view', 'volume']);
  });

  it('finds a setting by its name, with every action under it', () => {
    const groups = search('paged zoom');
    expect(rowsOf(groups).map((r) => r.target.key)).toEqual(['setting:zoom-paged']);
    expect(shownIds(groups)).toHaveLength(7);
  });

  it('finds one option by its name, and only that action', () => {
    expect(shownIds(search('fit to width'))).toEqual(['set.zoom-paged.to.zoomFitToWidth']);
    expect(shownIds(search('pink'))).toEqual(['set.ink-color.to.pink']);
  });

  it('finds an area by its name', () => {
    const groups = search('series editor');
    expect(groups.map((g) => g.group)).toContain('series-editor');
    expect(shownIds(groups)).toContain('series-editor.next-unlinked');
    expect(search('this volume').map((g) => g.group)).toEqual(['volume']);
    expect(shownIds(search('this volume'))).toContain('reader.offset-spreads');
  });

  it('finds an action by the label of a key bound to it', () => {
    const f = facts({ 'set.bold.toggle': ['Ctrl+KeyB'] });
    expect(shownIds(search('ctrl+b', f))).toEqual(['set.bold.toggle']);
    // A locked chord counts: Escape is Back's and edit mode's Step back.
    expect(shownIds(search('escape')).sort()).toEqual(['app.back', 'edit.back']);
  });

  it('needs every word', () => {
    expect(shownIds(search('zoom paged next'))).toEqual(['set.zoom-paged.next']);
    expect(search('zoom nothinglikethis')).toEqual([]);
  });
});

describe('filters', () => {
  it('Has a key: only the bound actions, a folded row down to its bound ones', () => {
    const f = facts({ 'set.zoom-paged.next': ['KeyX'] });
    const groups = groupTargets(targets, f, { ...NO_FILTER, hasKey: true });
    const ids = shownIds(groups);
    expect(ids).toContain('reader.fullscreen');
    expect(ids).toContain('set.zoom-paged.next');
    expect(ids).not.toContain('set.zoom-paged.prev');
    expect(ids).not.toContain('reader.goto-page');
    for (const id of ids) expect(f.chords.get(id as ActionId)!.length, id).toBeGreaterThan(0);
  });

  it('Changed: a changed key or a changed quick-menu choice', () => {
    const f = facts(
      { 'reader.fullscreen': [] },
      { 'set.bold.toggle': true, 'reader.zoom-fit': false }
    );
    const groups = groupTargets(targets, f, { ...NO_FILTER, changed: true });
    expect(shownIds(groups).sort()).toEqual(
      ['reader.fullscreen', 'reader.zoom-fit', 'set.bold.toggle'].sort()
    );
  });

  it('On the quick menu: the defaults and the additions', () => {
    const f = facts({}, { 'set.brightness.up': true, 'reader.fullscreen': false });
    const ids = shownIds(groupTargets(targets, f, { ...NO_FILTER, onMenu: true }));
    expect(ids).toContain('set.brightness.up');
    expect(ids).toContain('reader.page-left');
    expect(ids).not.toContain('reader.fullscreen');
    expect(ids).toHaveLength(8);
  });

  it('combine with each other and with the search', () => {
    const f = facts({}, { 'set.brightness.up': true });
    const groups = groupTargets(targets, f, { ...NO_FILTER, onMenu: true, query: 'brightness' });
    expect(shownIds(groups)).toEqual(['set.brightness.up']);
    // The group still knows how many rows it has in all.
    expect(groups[0].count).toBeGreaterThan(1);
  });
});

describe('profiles', () => {
  it('fold under one Profile row whatever their names', () => {
    const profile = target('setting:profile');
    expect(profile.label).toBe('Profile');
    const names = profile.actions.filter((a: KeyActionDef) => a.setting?.op === 'to');
    expect(names.length).toBeGreaterThan(0);
    for (const a of names) expect(labelWithin(profile, a)).toMatch(/^Set to /);
  });
});
