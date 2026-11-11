/**
 * Golden list: every action id generated from the setting definitions.
 *
 * Ids are stored in synced profiles (`Settings.keyBindings`,
 * `Settings.quickMenu`), so they are PERMANENT. An id that changes or
 * disappears here unbinds a key on somebody's device without a word. A
 * failure means one of:
 *
 * - a definition's `id` or a list option's stored value was renamed — undo it;
 * - a definition or an option was removed on purpose — its ids are retired
 *   (they stay in storage, ignored); delete them from this list;
 * - a definition or an option was added — add its ids here.
 *
 * The two `set.profile.to.*` entries are the built-in profiles; other
 * profiles add their own at run time.
 */
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS, type SettingDef } from '$lib/settings/setting-defs';
import { generateSettingActions, parseSettingActionId } from './generate';

const GOLDEN = [
  'set.wheel.next',
  'set.wheel.prev',
  'set.wheel.to.pan',
  'set.wheel.to.zoom',
  'set.wheel.to.turn',
  'reader.continuous',
  'set.page-view.next',
  'set.page-view.prev',
  'set.page-view.to.single',
  'set.page-view.to.dual',
  'set.page-view.to.auto',
  'set.scroll-mode.next',
  'set.scroll-mode.prev',
  'set.scroll-mode.to.auto',
  'set.scroll-mode.to.vertical',
  'set.scroll-mode.to.horizontal',
  'set.zoom-paged.next',
  'set.zoom-paged.prev',
  'set.zoom-paged.to.zoomFitToScreen',
  'set.zoom-paged.to.zoomFitToWidth',
  'set.zoom-paged.to.zoomFillScreen',
  'set.zoom-paged.to.zoomOriginal',
  'set.zoom-paged.to.keepZoom',
  'set.zoom-continuous.next',
  'set.zoom-continuous.prev',
  'set.zoom-continuous.to.zoomFillScreen',
  'set.zoom-continuous.to.zoomFitToScreen',
  'set.zoom-continuous.to.zoomOriginal',
  'reader.dividers',
  'set.page-transition.next',
  'set.page-transition.prev',
  'set.page-transition.to.none',
  'set.page-transition.to.crossfade',
  'set.page-transition.to.pageTurn',
  'set.page-transition.to.swipe',
  'set.bounds.toggle',
  'set.page-number.toggle',
  'set.char-count.toggle',
  'reader.timer',
  'set.quick-actions.toggle',
  'set.no-animations.toggle',
  'set.mobile.toggle',
  'set.paged-gap.up',
  'set.paged-gap.down',
  'set.paged-gap.reset',
  'set.scroll-gap.up',
  'set.scroll-gap.down',
  'set.scroll-gap.reset',
  'reader.night',
  'reader.invert',
  'reader.grayscale',
  'set.brightness.up',
  'set.brightness.down',
  'set.brightness.reset',
  'set.contrast.up',
  'set.contrast.down',
  'set.contrast.reset',
  'set.ink-color.next',
  'set.ink-color.prev',
  'set.ink-color.to.off',
  'set.ink-color.to.auto',
  'set.ink-color.to.red',
  'set.ink-color.to.orange',
  'set.ink-color.to.yellow',
  'set.ink-color.to.green',
  'set.ink-color.to.blue',
  'set.ink-color.to.violet',
  'set.ink-color.to.pink',
  'set.ink-strength.up',
  'set.ink-strength.down',
  'set.ink-strength.reset',
  'set.paper-tint.up',
  'set.paper-tint.down',
  'set.paper-tint.reset',
  'set.paper-age.up',
  'set.paper-age.down',
  'set.paper-age.reset',
  'set.ocr.toggle',
  'reader.ocr-always',
  'set.text-borders.toggle',
  'set.bold.toggle',
  'set.font-size.next',
  'set.font-size.prev',
  'set.font-size.to.auto',
  'set.font-size.to.original',
  'set.font-size.to.9',
  'set.font-size.to.10',
  'set.font-size.to.11',
  'set.font-size.to.12',
  'set.font-size.to.14',
  'set.font-size.to.16',
  'set.font-size.to.18',
  'set.font-size.to.20',
  'set.font-size.to.24',
  'set.font-size.to.32',
  'set.font-size.to.40',
  'set.font-size.to.48',
  'set.font-size.to.60',
  'set.text-menu.toggle',
  'set.rtl.toggle',
  'set.toolbar-dock.next',
  'set.toolbar-dock.prev',
  'set.toolbar-dock.to.top',
  'set.toolbar-dock.to.left',
  'set.profile.next',
  'set.profile.prev',
  'set.profile.to.Mobile',
  'set.profile.to.Desktop',
  'set.theme.next',
  'set.theme.prev',
  'set.theme.to.dark',
  'set.theme.to.eink',
  'set.theme.to.ice',
  'set.theme.to.sepia',
  'set.theme.to.nord',
  'set.theme.to.sakura',
  'set.theme.to.pastel',
  'set.theme.to.crimson',
  'set.theme.to.godzilla',
  'set.theme.to.custom',
  'set.anki-double-tap.toggle',
  'set.anki-card-mode.next',
  'set.anki-card-mode.prev',
  'set.anki-card-mode.to.create',
  'set.anki-card-mode.to.update',
  'set.gallery-layout.next',
  'set.gallery-layout.prev',
  'set.gallery-layout.to.grid',
  'set.gallery-layout.to.list',
  'set.gallery-sort.next',
  'set.gallery-sort.prev',
  'set.gallery-sort.to.SMART',
  'set.gallery-sort.to.ASC',
  'set.gallery-sort.to.DESC',
  'set.hide-completed.toggle',
  'set.stacking.next',
  'set.stacking.prev',
  'set.stacking.to.compact',
  'set.stacking.to.default',
  'set.stacking.to.spine',
  'set.stacking.to.custom',
  'set.title-language.next',
  'set.title-language.prev',
  'set.title-language.to.native',
  'set.title-language.to.english',
  'set.title-language.to.imported',
  'set.series-sort.next',
  'set.series-sort.prev',
  'set.series-sort.to.unread-first',
  'set.series-sort.to.alphabetical',
  'set.series-sort.to.reverse-alphabetical',
  'set.series-view.next',
  'set.series-view.prev',
  'set.series-view.to.grid',
  'set.series-view.to.list',
  'set.tracker-target.next',
  'set.tracker-target.prev',
  'set.tracker-target.to.daily',
  'set.tracker-target.to.weekly',
  'set.tracker-sort.next',
  'set.tracker-sort.prev',
  'set.tracker-sort.to.last-read',
  'set.tracker-sort.to.pages-per-period',
  'set.tracker-sort.to.pages-to-goal',
  'set.tracker-sort.to.fewest-pages',
  'set.tracker-sort.to.deadline',
  'set.tracker-completed.next',
  'set.tracker-completed.prev',
  'set.tracker-completed.to.volumes',
  'set.tracker-completed.to.series'
];

describe('generated action ids are permanent', () => {
  const generated = generateSettingActions(SETTING_DEFS as readonly SettingDef[]).map((a) => a.id);

  it('are exactly the golden list (order aside)', () => {
    expect([...generated].sort()).toEqual([...GOLDEN].sort());
  });

  it('holds 170 ids, none twice', () => {
    expect(GOLDEN).toHaveLength(170);
    expect(new Set(GOLDEN).size).toBe(GOLDEN.length);
  });

  it('every id is a pinned literal or parses back to its definition and operation', () => {
    const pinned = GOLDEN.filter((id) => !id.startsWith('set.'));
    expect(pinned.sort()).toEqual([
      'reader.continuous',
      'reader.dividers',
      'reader.grayscale',
      'reader.invert',
      'reader.night',
      'reader.ocr-always',
      'reader.timer'
    ]);
    for (const id of GOLDEN) {
      if (!id.startsWith('set.')) continue;
      expect(parseSettingActionId(id), id).not.toBeNull();
    }
  });
});
