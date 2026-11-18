import { describe, expect, it } from 'vitest';
import {
  GROUP_ORDER,
  KEY_ACTIONS,
  PINNED_ACTIONS,
  SCOPES,
  type KeyActionDef,
  type KeyScope
} from './actions';
import { normalizeChord } from './chord';
import { ICON_NAMES } from './icon-names';
import { ACTION_ICONS, actionIcon } from './icons';
import { compileKeymap, findConflicts } from './keymap';
import { allActions } from './registry';
import { refusalReason } from './reserved';

const hand = KEY_ACTIONS as readonly KeyActionDef[];
const all = allActions();

describe('the hand-registered actions', () => {
  it('has 84 actions with unique ids and labels: 31 from before the commands, 53 commands', () => {
    expect(hand).toHaveLength(84);
    expect(COMMANDS).toHaveLength(53);
    expect(new Set(hand.map((a) => a.id)).size).toBe(hand.length);
    expect(new Set(hand.map((a) => a.label)).size).toBe(hand.length);
  });

  it('puts every action in a known group, id prefixed by its scope family', () => {
    for (const a of hand) {
      expect(GROUP_ORDER).toContain(a.group);
      // The layer commands are `layer.*` (spec 17.10): they live in the
      // reader scope, where the displayed layer is, under their own prefix.
      const family = a.id.startsWith('layer.') ? 'reader' : a.id.split('.')[0];
      expect(family, a.id).toBe(a.scope.split('.')[0]);
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  it('no longer holds the cover toggle, nor the seven toggles their definitions generate', () => {
    const ids = hand.map((a) => a.id as string);
    expect(ids).not.toContain('reader.cover');
    for (const pinned of Object.keys(PINNED_ACTIONS)) expect(ids).not.toContain(pinned);
  });

  it('never repeats a toggle or a navigation away', () => {
    const repeating = hand.filter((a) => a.repeat).map((a) => a.id);
    expect(repeating.sort()).toEqual(
      [
        'reader.page-left',
        'reader.page-right',
        'reader.page-prev',
        'reader.page-next',
        'reader.scroll-up',
        'reader.scroll-down',
        'reader.scroll-left',
        'reader.scroll-right',
        // A held key keeps stepping the zoom, as a spun wheel does.
        'reader.zoom-in',
        'reader.zoom-out',
        'edit.undo',
        'edit.redo',
        'edit.delete'
      ].sort()
    );
  });
});

/**
 * The 53 commands of spec 17.10 (step B): id, scope, icon, and whether the
 * quick menu may ever hold it. Ids are stored in synced profiles, so a row
 * that changes here is a binding somebody loses.
 */
const COMMANDS: [id: string, scope: KeyScope, icon: string, menu: 'off' | 'never'][] = [
  // Reader
  ['reader.goto-page', 'reader', 'FileSearchOutline', 'off'],
  ['reader.zoom-in', 'reader', 'ZoomInOutline', 'off'],
  ['reader.zoom-out', 'reader', 'ZoomOutOutline', 'off'],
  ['reader.quick-menu', 'reader', 'DotsVerticalOutline', 'never'],
  // The owner's row "Reader: this volume / Mark volume read / unread".
  ['reader.volume-read', 'reader', 'CheckCircleOutline', 'off'],
  ['reader.timer-pause', 'reader', 'CirclePauseOutline', 'off'],
  ['reader.ocr-layer-prev', 'reader', 'LayersOutline', 'off'],
  ['reader.ocr-layers', 'reader', 'LayersOutline', 'off'],
  ['reader.ocr-layer-primary', 'reader', 'LayersOutline', 'off'],
  ['reader.copy-page-text', 'reader', 'FileCopyOutline', 'off'],
  ['reader.anki-image', 'reader', 'ImageOutline', 'off'],
  ['reader.anki-image-2', 'reader', 'ImageOutline', 'off'],
  // Layer commands: the picker's own icons
  ['layer.new', 'reader', 'CirclePlusOutline', 'off'],
  ['layer.rename', 'reader', 'EditOutline', 'off'],
  ['layer.promote', 'reader', 'ArrowUpOutline', 'off'],
  ['layer.publish', 'reader', 'UploadOutline', 'off'],
  ['layer.unpublish', 'reader', 'CloseCircleOutline', 'off'],
  ['layer.copy-to-edit', 'reader', 'FileCopyOutline', 'off'],
  ['layer.export', 'reader', 'DownloadOutline', 'off'],
  ['layer.delete', 'reader', 'TrashBinOutline', 'off'],
  // Edit mode
  ['edit.draw-tool', 'edit', 'DrawSquareOutline', 'off'],
  ['edit.merge', 'edit', 'MergeCellsOutline', 'off'],
  ['edit.split', 'edit', 'SplitCellsOutline', 'off'],
  ['edit.place-lines', 'edit', 'AlignJustifyOutline', 'off'],
  ['edit.flip', 'edit', 'SortHorizontalOutline', 'off'],
  ['edit.revert-page', 'edit', 'RefreshOutline', 'off'],
  // App: the five Open actions are never on the menu
  ['app.settings', 'app', 'CogOutline', 'off'],
  ['app.sync', 'app', 'RefreshOutline', 'off'],
  ['app.open-catalog', 'app', 'HomeOutline', 'never'],
  ['app.open-reading-speed', 'app', 'ChartLineUpOutline', 'never'],
  ['app.open-progress-tracker', 'app', 'CalendarMonthOutline', 'never'],
  ['app.open-upload', 'app', 'UploadOutline', 'never'],
  ['app.open-cloud', 'app', 'CloudArrowUpOutline', 'never'],
  // Library
  ['library.focus-search', 'library', 'SearchOutline', 'never'],
  ['library.series-open', 'library.series', 'BookOpenOutline', 'never'],
  // Volume row
  ['library.volume-open', 'library.volume', 'BookOpenReaderOutline', 'never'],
  ['library.volume-read', 'library.volume', 'CheckCircleOutline', 'never'],
  ['library.volume-download', 'library.volume', 'CloudArrowUpOutline', 'never'],
  ['library.volume-backup', 'library.volume', 'CloudArrowUpOutline', 'never'],
  ['library.volume-text', 'library.volume', 'FileLinesOutline', 'never'],
  ['library.volume-extract', 'library.volume', 'FileLinesOutline', 'never'],
  // Series page
  ['series.edit', 'series', 'EditOutline', 'never'],
  ['series.download-all', 'series', 'DownloadOutline', 'never'],
  ['series.backup', 'series', 'DownloadOutline', 'never'],
  ['series.remove', 'series', 'TrashBinOutline', 'never'],
  ['series.delete-cloud', 'series', 'TrashBinOutline', 'never'],
  ['series.clean-duplicates', 'series', 'TrashBinOutline', 'never'],
  ['series.extract', 'series', 'FileExportOutline', 'never'],
  ['series.text', 'series', 'FileExportOutline', 'never'],
  // The series editor dialog, the tracker, the text views
  ['series-editor.next-unlinked', 'series-editor', 'ForwardOutline', 'never'],
  ['series-editor.next-untitled', 'series-editor', 'ForwardOutline', 'never'],
  ['tracker.current-period', 'tracker', 'CalendarMonthOutline', 'never'],
  ['text.copy', 'text', 'ClipboardOutline', 'never']
];

/** What the registry held before the commands: these are the only hand ids not in the table. */
const BEFORE_COMMANDS = 31;

describe('the commands (spec 17.10)', () => {
  const byId = new Map(hand.map((a) => [a.id as string, a]));

  it('are exactly the 53 ids of the table, and nothing else was added', () => {
    expect(new Set(COMMANDS.map(([id]) => id)).size).toBe(COMMANDS.length);
    for (const [id] of COMMANDS) expect(byId.has(id), id).toBe(true);
    expect(hand.length - COMMANDS.length).toBe(BEFORE_COMMANDS);
  });

  it.each(COMMANDS)('%s: scope %s, icon %s, menu %s', (id, scope, icon, menu) => {
    const action = byId.get(id)!;
    expect(action.scope).toBe(scope);
    expect(action.icon).toBe(icon);
    expect(action.menu).toBe(menu);
  });

  it('all ship unbound: no default chord, no locked chord', () => {
    for (const [id] of COMMANDS) {
      const action = byId.get(id)!;
      expect(action.defaults, id).toEqual([]);
      expect(action.locked, id).toBeUndefined();
    }
  });

  it('only the zoom steps repeat on a held key', () => {
    expect(COMMANDS.map(([id]) => id).filter((id) => byId.get(id)!.repeat)).toEqual([
      'reader.zoom-in',
      'reader.zoom-out'
    ]);
  });

  it('edit commands are paged only; reader commands and Zoom to fit are live in every layout', () => {
    for (const [id, scope] of COMMANDS) {
      const modes = byId.get(id)!.modes;
      if (scope === 'edit') expect(modes, id).toEqual(['paged']);
      else if (scope === 'reader') expect(modes, id).toEqual(['paged', 'vertical', 'horizontal']);
      else expect(modes, id).toBeUndefined();
    }
    expect(byId.get('reader.zoom-fit')!.modes).toEqual(['paged', 'vertical', 'horizontal']);
  });
});

describe('the full registry', () => {
  it('has unique ids and unique labels', () => {
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
    const labels = all.map((a) => a.label);
    expect(labels.filter((l, i) => labels.indexOf(l) !== i)).toEqual([]);
  });

  it('gives every action a known group, scope, label and description', () => {
    for (const a of all) {
      expect(GROUP_ORDER, a.id).toContain(a.group);
      expect(Object.keys(SCOPES), a.id).toContain(a.scope);
      expect(a.label.length, a.id).toBeGreaterThan(0);
      expect(a.description.length, a.id).toBeGreaterThan(0);
    }
  });

  it('spells every default and locked chord canonically, and none is refused', () => {
    for (const a of all) {
      for (const c of [...a.defaults]) {
        expect(normalizeChord(c), `${a.id} ${c}`).toBe(c);
        expect(refusalReason(c), `${a.id} ${c}`).toBeNull();
      }
      for (const c of a.locked ?? []) expect(normalizeChord(c)).toBe(c);
    }
  });

  it('has no conflicts at defaults', () => {
    expect(findConflicts(compileKeymap({}, all)).size).toBe(0);
  });

  it('gives every action an icon that the map resolves to a component', () => {
    for (const a of all) {
      expect(ICON_NAMES, a.id).toContain(a.icon);
      expect(actionIcon(a.icon), `${a.id} ${a.icon}`).toBeTruthy();
    }
    expect(Object.keys(ACTION_ICONS).sort()).toEqual([...ICON_NAMES].sort());
    // No name is carried that nothing uses.
    const used = new Set(all.map((a) => a.icon));
    expect(ICON_NAMES.filter((n) => !used.has(n))).toEqual([]);
  });

  it('lets nothing outside reader, edit and app onto the quick menu', () => {
    const eligible: KeyScope[] = ['reader', 'edit', 'app'];
    for (const a of all) {
      expect(['off', 'never'], a.id).toContain(a.menu);
      if (!eligible.includes(a.scope)) expect(a.menu, a.id).toBe('never');
    }
    // The menu's own button and the wheel list can never be on it either.
    const never = (id: string) => all.find((a) => a.id === id)?.menu;
    expect(never('set.quick-actions.toggle')).toBe('never');
    expect(never('set.wheel.next')).toBe('never');
    expect(never('set.wheel.to.turn')).toBe('never');
    expect(never('reader.fullscreen')).toBe('off');
    expect(never('set.bold.toggle')).toBe('off');
    expect(never('set.theme.next')).toBe('off');
  });

  it('describes every scope: a shadowed scope exists, and only a dialog hides from app', () => {
    for (const [scope, def] of Object.entries(SCOPES)) {
      expect(def.label.length, scope).toBeGreaterThan(0);
      for (const under of def.shadows) {
        expect(Object.keys(SCOPES), `${scope} → ${under}`).toContain(under);
        expect(def.when, `${scope} needs the words for its capture note`).toBeTruthy();
      }
    }
    expect(SCOPES.edit.shadows).toEqual(['reader', 'app']);
    expect(SCOPES['library.series'].shadows).toEqual(['library']);
    expect(SCOPES['library.volume'].shadows).toEqual(['series']);
    expect(
      Object.entries(SCOPES)
        .filter(([, d]) => d.dialog)
        .map(([s]) => s)
    ).toEqual(['series-editor']);
  });
});
