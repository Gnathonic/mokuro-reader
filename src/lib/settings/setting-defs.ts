/**
 * Setting definitions (#55, spec 17.2): one entry per BINDABLE setting, as
 * data. Two consumers read the same entry, so each option list exists once:
 *
 * - the settings UI imports its option lists (and slider limits) from here;
 * - `$lib/keys/generate.ts` turns every entry into key actions
 *   (toggle → Toggle; list → Next, Previous, one "Set to" per option;
 *   slider → Step up, Step down, Reset), and `$lib/keys/setting-actions.ts`
 *   is the ONE handler for all of them.
 *
 * `id` is PERMANENT: it is part of the action ids stored in synced profiles
 * (`set.<id>.next`). Chosen by hand, kebab-case, no dots; never derived from
 * a label or a storage key, and never renamed. A list option's `value` is the
 * stored value itself, which is permanent already.
 *
 * `read`/`write` come from one helper per settings home (profile, Anki,
 * catalog, device, open volume). A definition overrides them where the
 * control does more than store a value: see `wheel`, `anki-double-tap`,
 * `stacking`, `hide-completed`, `theme`, `profile`, `scroll-gap`.
 *
 * Not here yet, because the settings are not on this branch: tap page edges
 * to turn (#54), Page Up/Down scroll first (#283), image adjustment on/off
 * (#362). Each is one toggle definition.
 */
import { get, type Writable } from 'svelte/store';
import type { ActionGroup, KeyScope, PinnedActionId, ReaderMode } from '$lib/keys/actions';
import type { IconName } from '$lib/keys/icon-names';
import {
  INK_COLOR_SETTINGS,
  INK_STRENGTH_DEFAULT,
  INK_STRENGTH_MAX,
  INK_STRENGTH_MIN,
  PAPER_AGE_DEFAULT,
  PAPER_AGE_MAX,
  PAPER_AGE_MIN,
  PAPER_TINT_DEFAULT,
  PAPER_TINT_MAX,
  PAPER_TINT_MIN,
  clampInkStrength,
  clampPaperAge,
  clampPaperTint,
  sanitizeInkColor
} from '$lib/reader/ink-color';
import {
  PAGE_ADJUST_DEFAULT,
  PAGE_ADJUST_MAX,
  PAGE_ADJUST_MIN,
  PAGE_ADJUST_STEP,
  clampPageAdjust
} from '$lib/reader/page-filter';
import { GAP_WHEEL_STEP_SIZE, MAX_PAGE_GAP } from '$lib/reader/zoom-math';
import { applyCatalogPreset, markCatalogPresetCustom } from './catalog-presets';
import { miscSettings, updateMiscSetting, type MiscSettingsKey } from './misc';
import { seriesSortMode, seriesViewMode } from './series-view-prefs';
import {
  changeProfile,
  currentProfile,
  profiles,
  settings,
  updateAnkiSetting,
  updateCatalogSetting,
  updateSetting,
  type AnkiSettingsKey,
  type CatalogSettingsKey,
  type CatalogStackingPreset,
  type FontSize,
  type ScheduleSettingKey,
  type SettingsKey
} from './settings';
import { PRESETS } from './theme';
import { updateVolumeSetting, volumes } from './volume-data';

export interface SettingOption {
  /** The stored value. Part of the action id (`set.<def>.to.<value>`). */
  readonly value: string;
  readonly name: string;
}

export type SettingOptions = readonly SettingOption[];

/** What an action needs that is not global: the open volume, in the reader. */
export interface SettingCtx {
  volumeId?: string;
}

interface SettingBase {
  /** Stable token used in action ids. Never renamed. */
  readonly id: string;
  readonly label: string;
  /** The key action's one-line description; a default is generated when absent. */
  readonly description?: string;
  readonly group: ActionGroup;
  readonly scope: KeyScope;
  /** Reader layouts the setting applies in; absent = all. */
  readonly modes?: readonly ReaderMode[];
  readonly icon: IconName;
  /** May its actions be put on the quick menu? */
  readonly menu: 'off' | 'never';
  /** False when the setting has nothing to act on (a volume setting, no volume open). */
  available?(ctx: SettingCtx): boolean;
  read(ctx: SettingCtx): unknown;
  write(ctx: SettingCtx, value: unknown): void;
  /** Appended to the announcement in brackets: "(print effect off)". */
  note?(ctx: SettingCtx): string | undefined;
}

export type ToggleSettingDef = SettingBase & {
  readonly kind: 'toggle';
  /** A toggle that predates the definitions keeps its action id (spec 17.3). */
  readonly actionId?: PinnedActionId;
  /** The filter's schedule. While it is on, the toggle changes nothing (spec 17.5). */
  readonly schedule?: ScheduleSettingKey;
  /** The name the schedule message has always used ("Night Mode is on automatic schedule"). */
  readonly scheduleName?: string;
};

export type ListSettingDef = SettingBase & {
  readonly kind: 'list';
  /** In the order Next walks them. A function when the list is not a constant (profiles). */
  readonly options: SettingOptions | ((ctx: SettingCtx) => SettingOptions);
  /** Next past the last option goes to the first. Default true. */
  readonly wrap?: boolean;
};

export type SliderSettingDef = SettingBase & {
  readonly kind: 'slider';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly reset: number;
  format(value: number): string;
};

export type SettingDef = ToggleSettingDef | ListSettingDef | SliderSettingDef;

// ---------------------------------------------------------------------------
// One read/write pair per settings home
// ---------------------------------------------------------------------------

type Access = Pick<SettingBase, 'read' | 'write' | 'available'>;

/** A field of the active profile. */
function profile(key: SettingsKey): Access {
  return {
    read: () => get(settings)?.[key],
    write: (_ctx, value) => updateSetting(key, value)
  };
}

/** A field of the active profile's AnkiConnect settings. */
function anki(key: AnkiSettingsKey): Access {
  return {
    read: () => get(settings)?.ankiConnectSettings?.[key],
    write: (_ctx, value) => updateAnkiSetting(key, value)
  };
}

/** A field of the active profile's catalog settings. */
function catalog(key: CatalogSettingsKey): Access {
  return {
    read: () => get(settings)?.catalogSettings?.[key],
    write: (_ctx, value) => updateCatalogSetting(key, value)
  };
}

/** A per-device setting (`miscSettings`, localStorage only). */
function device(key: MiscSettingsKey): Access {
  return {
    read: () => get(miscSettings)[key],
    write: (_ctx, value) => updateMiscSetting(key, value)
  };
}

/** A per-device preference with its own store. */
function stored<T>(store: Writable<T>): Access {
  return {
    read: () => get(store),
    write: (_ctx, value) => store.set(value as T)
  };
}

/** A setting of the OPEN volume; falls back to the profile's volume default, as the reader does. */
function openVolume(key: 'rightToLeft'): Access {
  return {
    available: (ctx) => !!ctx.volumeId,
    read: (ctx) => {
      if (!ctx.volumeId) return undefined;
      const own = get(volumes)?.[ctx.volumeId]?.settings?.[key];
      return own ?? get(settings)?.volumeDefaults?.[key];
    },
    write: (ctx, value) => {
      if (ctx.volumeId) updateVolumeSetting(ctx.volumeId, key, value);
    }
  };
}

// ---------------------------------------------------------------------------
// Option lists
// ---------------------------------------------------------------------------

const PAGED = ['paged'] as const;
const CONTINUOUS = ['vertical', 'horizontal'] as const;
const PAGED_HORIZONTAL = ['paged', 'horizontal'] as const;

const FONT_SIZES: readonly FontSize[] = [
  'auto',
  'original',
  '9',
  '10',
  '11',
  '12',
  '14',
  '16',
  '18',
  '20',
  '24',
  '32',
  '40',
  '48',
  '60'
];

const capitalised = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Mouse wheel in paged mode: two stored booleans, one choice. `wheelTurnsPages` wins. */
export type WheelMode = 'pan' | 'zoom' | 'turn';

const px = (v: number) => `${v}px`;
const percent = (v: number) => `${v}%`;
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

/** One wheel notch of the Ctrl+Shift+wheel gap chord, in px. */
const GAP_STEP = 100 / GAP_WHEEL_STEP_SIZE;

const printEffectOff = () =>
  sanitizeInkColor(get(settings)?.pageInkColor) === 'off' ? 'print effect off' : undefined;

// ---------------------------------------------------------------------------
// The definitions
// ---------------------------------------------------------------------------

export const SETTING_DEFS = [
  // ---- Reader: navigation --------------------------------------------------
  {
    id: 'wheel',
    kind: 'list',
    label: 'Mouse wheel',
    description: 'What a plain wheel does in paged mode.',
    group: 'pages',
    scope: 'reader',
    icon: 'SortOutline',
    menu: 'never',
    options: [
      { value: 'pan', name: 'Pans / scrolls (Ctrl+wheel zooms)' },
      { value: 'zoom', name: 'Zooms (Ctrl+wheel pans)' },
      { value: 'turn', name: 'Turns pages (Ctrl+wheel zooms)' }
    ],
    read: (): WheelMode => {
      const s = get(settings);
      return s?.wheelTurnsPages ? 'turn' : s?.swapWheelBehavior ? 'zoom' : 'pan';
    },
    write: (_ctx, value) => {
      updateSetting('wheelTurnsPages', value === 'turn');
      updateSetting('swapWheelBehavior', value === 'zoom');
    }
  },
  // ---- Reader: view --------------------------------------------------------
  {
    id: 'continuous',
    kind: 'toggle',
    actionId: 'reader.continuous',
    label: 'Continuous scroll',
    group: 'view',
    scope: 'reader',
    icon: 'ArrowsRepeatOutline',
    menu: 'off',
    ...profile('continuousScroll')
  },
  {
    id: 'page-view',
    kind: 'list',
    label: 'Page view mode',
    group: 'view',
    scope: 'reader',
    modes: PAGED,
    icon: 'BookOpenOutline',
    menu: 'off',
    options: [
      { value: 'single', name: 'Single page' },
      { value: 'dual', name: 'Dual page' },
      { value: 'auto', name: 'Auto (detect orientation & spreads)' }
    ],
    ...profile('singlePageView')
  },
  {
    id: 'scroll-mode',
    kind: 'list',
    label: 'Scroll mode',
    group: 'view',
    scope: 'reader',
    modes: CONTINUOUS,
    icon: 'SortOutline',
    menu: 'off',
    options: [
      { value: 'auto', name: 'Match orientation' },
      { value: 'vertical', name: 'Vertical scroll' },
      { value: 'horizontal', name: 'Horizontal scroll' }
    ],
    ...profile('scrollMode')
  },
  {
    id: 'zoom-paged',
    kind: 'list',
    label: 'Paged zoom',
    group: 'view',
    scope: 'reader',
    modes: PAGED,
    icon: 'ZoomInOutline',
    menu: 'off',
    options: [
      { value: 'zoomFitToScreen', name: 'Fit to screen' },
      { value: 'zoomFitToWidth', name: 'Fit to width' },
      { value: 'zoomFillScreen', name: 'Fill screen' },
      { value: 'zoomOriginal', name: 'Original size' },
      { value: 'keepZoom', name: 'Keep zoom' }
    ],
    ...profile('zoomDefault')
  },
  {
    id: 'zoom-continuous',
    kind: 'list',
    label: 'Continuous zoom',
    group: 'view',
    scope: 'reader',
    modes: CONTINUOUS,
    icon: 'ZoomInOutline',
    menu: 'off',
    options: [
      { value: 'zoomFillScreen', name: 'Fill screen' },
      { value: 'zoomFitToScreen', name: 'Fit to screen' },
      { value: 'zoomOriginal', name: 'Original size (1:1)' }
    ],
    ...profile('continuousZoomDefault')
  },
  {
    id: 'dividers',
    kind: 'toggle',
    actionId: 'reader.dividers',
    label: 'Page dividers',
    group: 'view',
    scope: 'reader',
    modes: CONTINUOUS,
    icon: 'HorizontalLinesOutline',
    menu: 'off',
    ...profile('pageDividers')
  },
  {
    id: 'page-transition',
    kind: 'list',
    label: 'Page transition',
    group: 'view',
    scope: 'reader',
    modes: PAGED,
    icon: 'ShuffleOutline',
    menu: 'off',
    options: [
      { value: 'none', name: 'None' },
      { value: 'crossfade', name: 'Crossfade' },
      { value: 'pageTurn', name: 'Page Turn' },
      { value: 'swipe', name: 'Swipe' }
    ],
    ...profile('pageTransition')
  },
  {
    id: 'bounds',
    kind: 'toggle',
    label: 'Bounds',
    description: 'Keep a zoomed page inside the screen.',
    group: 'view',
    scope: 'reader',
    modes: PAGED,
    icon: 'DrawSquareOutline',
    menu: 'off',
    ...profile('bounds')
  },
  {
    id: 'page-number',
    kind: 'toggle',
    label: 'Show page number',
    group: 'view',
    scope: 'reader',
    icon: 'OrderedListOutline',
    menu: 'off',
    ...profile('pageNum')
  },
  {
    id: 'char-count',
    kind: 'toggle',
    label: 'Show character count',
    group: 'view',
    scope: 'reader',
    icon: 'TextSizeOutline',
    menu: 'off',
    ...profile('charCount')
  },
  {
    id: 'timer',
    kind: 'toggle',
    actionId: 'reader.timer',
    label: 'Show timer',
    group: 'view',
    scope: 'reader',
    icon: 'ClockOutline',
    menu: 'off',
    ...profile('showTimer')
  },
  {
    id: 'quick-actions',
    kind: 'toggle',
    label: 'Show quick actions button',
    group: 'view',
    scope: 'reader',
    icon: 'DotsVerticalOutline',
    // The menu's own button: it can be hidden by a key, never from the menu.
    menu: 'never',
    ...profile('quickActions')
  },
  {
    id: 'no-animations',
    kind: 'toggle',
    label: 'Disable animations',
    description: 'Skip zoom, pan and page-turn animations (e-ink).',
    group: 'view',
    scope: 'reader',
    icon: 'BanOutline',
    menu: 'off',
    ...profile('disableAnimations')
  },
  {
    id: 'mobile',
    kind: 'toggle',
    label: 'Mobile mode',
    description: 'Swipe at the edge of a zoomed page to turn it.',
    group: 'view',
    scope: 'reader',
    modes: PAGED,
    icon: 'MobilePhoneOutline',
    menu: 'off',
    ...profile('mobile')
  },
  {
    id: 'paged-gap',
    kind: 'slider',
    label: 'Paged gap',
    description: 'The gap between the two pages of a spread.',
    group: 'view',
    scope: 'reader',
    modes: PAGED,
    icon: 'ColumnOutline',
    menu: 'off',
    min: 0,
    max: MAX_PAGE_GAP,
    step: GAP_STEP,
    reset: 0,
    format: px,
    ...profile('pagedGap')
  },
  {
    id: 'scroll-gap',
    kind: 'slider',
    label: 'Scroll gap',
    description: 'The gap between pages in continuous scroll. Above 0 it turns the dividers on.',
    group: 'view',
    scope: 'reader',
    modes: CONTINUOUS,
    icon: 'TableRowOutline',
    menu: 'off',
    min: 0,
    max: MAX_PAGE_GAP,
    step: GAP_STEP,
    reset: 0,
    format: px,
    read: () => get(settings)?.scrollGap,
    // As the Ctrl+Shift+wheel chord does: the dividers follow the gap.
    write: (_ctx, value) => {
      updateSetting('scrollGap', value);
      const dividers = (value as number) > 0;
      if (get(settings)?.pageDividers !== dividers) updateSetting('pageDividers', dividers);
    }
  },
  // ---- Reader: image -------------------------------------------------------
  {
    id: 'night',
    kind: 'toggle',
    actionId: 'reader.night',
    schedule: 'nightModeSchedule',
    scheduleName: 'Night Mode',
    label: 'Night mode',
    group: 'filters',
    scope: 'reader',
    icon: 'MoonOutline',
    menu: 'off',
    ...profile('nightMode')
  },
  {
    id: 'invert',
    kind: 'toggle',
    actionId: 'reader.invert',
    schedule: 'invertColorsSchedule',
    scheduleName: 'Invert',
    label: 'Invert colors',
    group: 'filters',
    scope: 'reader',
    icon: 'SunOutline',
    menu: 'off',
    ...profile('invertColors')
  },
  {
    id: 'grayscale',
    kind: 'toggle',
    actionId: 'reader.grayscale',
    schedule: 'grayscaleSchedule',
    scheduleName: 'B&W',
    label: 'Black & white',
    group: 'filters',
    scope: 'reader',
    icon: 'PaletteOutline',
    menu: 'off',
    ...profile('grayscale')
  },
  {
    id: 'brightness',
    kind: 'slider',
    label: 'Brightness',
    description: 'Page image brightness. The OCR text is never filtered.',
    group: 'filters',
    scope: 'reader',
    icon: 'SunOutline',
    menu: 'off',
    min: PAGE_ADJUST_MIN,
    max: PAGE_ADJUST_MAX,
    step: PAGE_ADJUST_STEP,
    reset: PAGE_ADJUST_DEFAULT,
    format: percent,
    read: () => clampPageAdjust(get(settings)?.pageBrightness),
    write: (_ctx, value) => updateSetting('pageBrightness', clampPageAdjust(value))
  },
  {
    id: 'contrast',
    kind: 'slider',
    label: 'Contrast',
    description: 'Page image contrast. The OCR text is never filtered.',
    group: 'filters',
    scope: 'reader',
    icon: 'AdjustmentsVerticalOutline',
    menu: 'off',
    min: PAGE_ADJUST_MIN,
    max: PAGE_ADJUST_MAX,
    step: PAGE_ADJUST_STEP,
    reset: PAGE_ADJUST_DEFAULT,
    format: percent,
    read: () => clampPageAdjust(get(settings)?.pageContrast),
    write: (_ctx, value) => updateSetting('pageContrast', clampPageAdjust(value))
  },
  {
    id: 'ink-color',
    kind: 'list',
    label: 'Magazine print effect',
    description: 'Colored ink on tinted newsprint, for black-and-white pages.',
    group: 'filters',
    scope: 'reader',
    icon: 'SwatchbookOutline',
    menu: 'off',
    options: INK_COLOR_SETTINGS.map((value) => ({ value, name: capitalised(value) })),
    read: () => sanitizeInkColor(get(settings)?.pageInkColor),
    write: (_ctx, value) => updateSetting('pageInkColor', sanitizeInkColor(value))
  },
  {
    id: 'ink-strength',
    kind: 'slider',
    label: 'Ink strength',
    description: 'Print effect: faded to deep ink.',
    group: 'filters',
    scope: 'reader',
    icon: 'SwatchbookOutline',
    menu: 'off',
    min: INK_STRENGTH_MIN,
    max: INK_STRENGTH_MAX,
    step: 5,
    reset: INK_STRENGTH_DEFAULT,
    format: signed,
    note: printEffectOff,
    read: () => clampInkStrength(get(settings)?.pageInkStrength),
    write: (_ctx, value) => updateSetting('pageInkStrength', clampInkStrength(value))
  },
  {
    id: 'paper-tint',
    kind: 'slider',
    label: 'Paper tint',
    description: 'Print effect: how much of the ink colour the paper takes.',
    group: 'filters',
    scope: 'reader',
    icon: 'SwatchbookOutline',
    menu: 'off',
    min: PAPER_TINT_MIN,
    max: PAPER_TINT_MAX,
    step: 1,
    reset: PAPER_TINT_DEFAULT,
    format: percent,
    note: printEffectOff,
    read: () => clampPaperTint(get(settings)?.pagePaperTint),
    write: (_ctx, value) => updateSetting('pagePaperTint', clampPaperTint(value))
  },
  {
    id: 'paper-age',
    kind: 'slider',
    label: 'Paper age',
    description: 'Print effect: fresh paper to old newsprint.',
    group: 'filters',
    scope: 'reader',
    icon: 'SwatchbookOutline',
    menu: 'off',
    min: PAPER_AGE_MIN,
    max: PAPER_AGE_MAX,
    step: 5,
    reset: PAPER_AGE_DEFAULT,
    format: (v) => `${v}`,
    note: printEffectOff,
    read: () => clampPaperAge(get(settings)?.pagePaperAge),
    write: (_ctx, value) => updateSetting('pagePaperAge', clampPaperAge(value))
  },
  // ---- Reader: text --------------------------------------------------------
  {
    id: 'ocr',
    kind: 'toggle',
    label: 'OCR enabled',
    group: 'ocr',
    scope: 'reader',
    icon: 'CaptionOutline',
    menu: 'off',
    ...profile('displayOCR')
  },
  {
    id: 'ocr-always',
    kind: 'toggle',
    actionId: 'reader.ocr-always',
    label: 'Always show OCR',
    group: 'ocr',
    scope: 'reader',
    icon: 'EyeOutline',
    menu: 'off',
    ...profile('alwaysShowOCR')
  },
  {
    id: 'text-borders',
    kind: 'toggle',
    label: 'Text box borders',
    group: 'ocr',
    scope: 'reader',
    icon: 'DrawSquareOutline',
    menu: 'off',
    ...profile('textBoxBorders')
  },
  {
    id: 'bold',
    kind: 'toggle',
    label: 'Bold font',
    group: 'ocr',
    scope: 'reader',
    icon: 'LetterBoldOutline',
    menu: 'off',
    ...profile('boldFont')
  },
  {
    id: 'font-size',
    kind: 'list',
    label: 'Font size',
    description: 'Auto, the file’s own size, or a fixed size. Next is bigger.',
    group: 'ocr',
    scope: 'reader',
    icon: 'TextSizeOutline',
    menu: 'off',
    // Next and Previous read as bigger and smaller: they stop at the ends.
    wrap: false,
    options: FONT_SIZES.map((value) => ({ value, name: value })),
    ...profile('fontSize')
  },
  {
    id: 'text-menu',
    kind: 'toggle',
    label: 'Custom text box menu',
    description: 'Quick copy and Anki card creation on right-click or long-press.',
    group: 'ocr',
    scope: 'reader',
    icon: 'MessageDotsOutline',
    menu: 'off',
    ...profile('textBoxContextMenu')
  },
  // ---- Reader: this volume -------------------------------------------------
  {
    id: 'rtl',
    kind: 'toggle',
    label: 'Right to left',
    description: 'The reading direction of the open volume.',
    group: 'view',
    scope: 'reader',
    modes: PAGED_HORIZONTAL,
    icon: 'ArrowsRepeatOutline',
    menu: 'off',
    ...openVolume('rightToLeft')
  },
  // ---- Reader: edit --------------------------------------------------------
  {
    id: 'toolbar-dock',
    kind: 'list',
    label: 'Edit toolbar',
    description: 'Where the OCR edit toolbar docks.',
    group: 'edit',
    scope: 'edit',
    modes: PAGED,
    icon: 'ObjectsColumnOutline',
    menu: 'off',
    options: [
      { value: 'top', name: 'Top' },
      { value: 'left', name: 'Left' }
    ],
    ...device('editToolbarDock')
  },
  // ---- App -----------------------------------------------------------------
  {
    id: 'profile',
    kind: 'list',
    label: 'Profile',
    description: 'The active settings profile.',
    group: 'general',
    scope: 'app',
    icon: 'UserSettingsOutline',
    menu: 'off',
    // The one dynamic list: its "Set to" actions are rebuilt when the set of
    // profile names changes (`$lib/keys/live.ts`).
    options: () => Object.keys(get(profiles)).map((name) => ({ value: name, name })),
    read: () => get(currentProfile),
    write: (_ctx, value) => changeProfile(String(value))
  },
  {
    id: 'theme',
    kind: 'list',
    label: 'Theme',
    group: 'general',
    scope: 'app',
    icon: 'PaletteOutline',
    menu: 'off',
    options: [
      ...Object.values(PRESETS).map((p) => ({ value: p.id, name: p.name })),
      { value: 'custom', name: 'Custom' }
    ],
    read: () => get(settings)?.theme ?? 'dark',
    // Only SELECTS Custom. The swatch in Appearance also re-seeds the custom
    // colours from the active preset; a key must never overwrite a palette.
    write: (_ctx, value) => updateSetting('theme', value)
  },
  {
    id: 'anki-double-tap',
    kind: 'toggle',
    label: 'Anki double-tap capture',
    description: 'Double-tap a text box to capture it to Anki.',
    group: 'general',
    scope: 'reader',
    icon: 'FileCirclePlusOutline',
    menu: 'off',
    // A toggle over `triggerMethod`: doubleTap/both = on.
    read: () => {
      const method = get(settings)?.ankiConnectSettings?.triggerMethod;
      return method === 'doubleTap' || method === 'both';
    },
    write: (_ctx, value) => updateAnkiSetting('triggerMethod', value ? 'doubleTap' : 'neither')
  },
  {
    id: 'anki-card-mode',
    kind: 'list',
    label: 'Anki card mode',
    description: 'Create a new card, or update the last one.',
    group: 'general',
    scope: 'reader',
    icon: 'FileCirclePlusOutline',
    menu: 'off',
    options: [
      { value: 'create', name: 'Create new card' },
      { value: 'update', name: 'Update last card (within 5 min)' }
    ],
    ...anki('cardMode')
  },
  // ---- Library -------------------------------------------------------------
  {
    id: 'gallery-layout',
    kind: 'list',
    label: 'Gallery layout',
    group: 'library',
    scope: 'library',
    icon: 'GridOutline',
    menu: 'never',
    options: [
      { value: 'grid', name: 'Grid' },
      { value: 'list', name: 'List' }
    ],
    ...device('galleryLayout')
  },
  {
    id: 'gallery-sort',
    kind: 'list',
    label: 'Gallery sort',
    group: 'library',
    scope: 'library',
    icon: 'SortOutline',
    menu: 'never',
    options: [
      { value: 'SMART', name: 'Smart' },
      { value: 'ASC', name: 'A-Z' },
      { value: 'DESC', name: 'Z-A' }
    ],
    ...device('gallerySorting')
  },
  {
    id: 'hide-completed',
    kind: 'toggle',
    label: 'Hide completed volumes',
    description: 'Leave finished volumes out of a series’ thumbnail stack.',
    group: 'library',
    scope: 'library',
    icon: 'EyeSlashOutline',
    menu: 'never',
    read: () => get(settings)?.catalogSettings?.hideReadVolumes ?? true,
    // As the control does: a stacking setting changed by hand is Custom.
    write: (_ctx, value) => {
      updateCatalogSetting('hideReadVolumes', value);
      markCatalogPresetCustom();
    }
  },
  {
    id: 'stacking',
    kind: 'list',
    label: 'Stacking preset',
    description: 'How a series’ thumbnails stack in the catalog.',
    group: 'library',
    scope: 'library',
    icon: 'CubesStackedOutline',
    menu: 'never',
    options: [
      { value: 'compact', name: 'Compact' },
      { value: 'default', name: 'Default' },
      { value: 'spine', name: 'Spine Showcase' },
      { value: 'custom', name: 'Custom' }
    ],
    read: () => get(settings)?.catalogSettings?.stackingPreset,
    // A preset stands for eight catalog settings; selecting it writes them.
    write: (_ctx, value) => applyCatalogPreset(value as CatalogStackingPreset)
  },
  {
    id: 'title-language',
    kind: 'list',
    label: 'Preferred series title',
    description: 'Which series title the catalog shows.',
    group: 'library',
    scope: 'library',
    icon: 'LanguageOutline',
    menu: 'never',
    options: [
      { value: 'native', name: 'Native (日本語 → romaji → English)' },
      { value: 'english', name: 'English (→ romaji → 日本語)' },
      { value: 'imported', name: 'As imported (folder name)' }
    ],
    ...catalog('preferredTitleLanguage')
  },
  // ---- Series page ---------------------------------------------------------
  {
    id: 'series-sort',
    kind: 'list',
    label: 'Series sort',
    description: 'The order of a series page’s volumes.',
    group: 'library',
    scope: 'series',
    icon: 'ArrowSortLettersOutline',
    menu: 'never',
    options: [
      { value: 'unread-first', name: 'Unread first' },
      { value: 'alphabetical', name: 'Default' },
      { value: 'reverse-alphabetical', name: 'Reverse default' }
    ],
    ...stored(seriesSortMode)
  },
  {
    id: 'series-view',
    kind: 'list',
    label: 'Series view',
    description: 'A series page as a grid or a list.',
    group: 'library',
    scope: 'series',
    icon: 'GridOutline',
    menu: 'never',
    options: [
      { value: 'grid', name: 'Grid' },
      { value: 'list', name: 'List' }
    ],
    ...stored(seriesViewMode)
  },
  // ---- Progress tracker ----------------------------------------------------
  {
    id: 'tracker-target',
    kind: 'list',
    label: 'Tracker targets',
    description: 'Progress tracker: daily or weekly targets.',
    group: 'other',
    scope: 'tracker',
    icon: 'ChartLineUpOutline',
    menu: 'never',
    options: [
      { value: 'daily', name: 'Daily' },
      { value: 'weekly', name: 'Weekly' }
    ],
    read: () => get(miscSettings).progressTargetMode ?? 'daily',
    write: (_ctx, value) => updateMiscSetting('progressTargetMode', value)
  },
  {
    id: 'tracker-sort',
    kind: 'list',
    label: 'Tracker sort',
    description: 'Progress tracker: the order of the volumes in progress.',
    group: 'other',
    scope: 'tracker',
    icon: 'ChartLineUpOutline',
    menu: 'never',
    options: [
      { value: 'last-read', name: 'Last Read' },
      { value: 'pages-per-period', name: 'Pages/Day' },
      { value: 'pages-to-goal', name: 'Pages to Goal' },
      { value: 'fewest-pages', name: 'Fewest Pages' },
      { value: 'deadline', name: 'Deadline' }
    ],
    ...device('progressTrackerSorting')
  },
  {
    id: 'tracker-completed',
    kind: 'list',
    label: 'Tracker completed view',
    description: 'Progress tracker: completed volumes one by one, or by series.',
    group: 'other',
    scope: 'tracker',
    icon: 'ChartLineUpOutline',
    menu: 'never',
    options: [
      { value: 'volumes', name: 'Volumes' },
      { value: 'series', name: 'Series' }
    ],
    read: () => get(miscSettings).completedVolumesViewMode ?? 'volumes',
    write: (_ctx, value) => updateMiscSetting('completedVolumesViewMode', value)
  }
] as const satisfies readonly SettingDef[];

export type SettingDefId = (typeof SETTING_DEFS)[number]['id'];
type DefOfKind<K extends SettingDef['kind']> = Extract<(typeof SETTING_DEFS)[number], { kind: K }>;
export type ListSettingId = DefOfKind<'list'>['id'];
export type SliderSettingId = DefOfKind<'slider'>['id'];
export type ToggleSettingId = DefOfKind<'toggle'>['id'];

const DEFS_BY_ID: ReadonlyMap<string, SettingDef> = new Map(
  (SETTING_DEFS as readonly SettingDef[]).map((def) => [def.id, def])
);

/** The definition for an id from storage or a generated action; undefined when retired. */
export function findSettingDef(id: string): SettingDef | undefined {
  return DEFS_BY_ID.get(id);
}

export function settingDef(id: SettingDefId): SettingDef {
  return DEFS_BY_ID.get(id)!;
}

/** A list's options right now (the profile list is read from its store). */
export function resolveOptions(def: ListSettingDef, ctx: SettingCtx = {}): SettingOptions {
  return typeof def.options === 'function' ? def.options(ctx) : def.options;
}

/**
 * A list setting's options for a select: a fresh, mutable `{ value, name }[]`
 * typed to the setting's stored value. The components' ONE source for them.
 */
export function listOptions<V extends string = string>(
  id: ListSettingId
): { value: V; name: string }[] {
  const def = settingDef(id) as ListSettingDef;
  return resolveOptions(def).map((o) => ({ value: o.value as V, name: o.name }));
}

/** An option's display name ("Fit to width"); the raw value when it is not one of them. */
export function optionName(id: ListSettingId, value: unknown): string {
  const def = settingDef(id) as ListSettingDef;
  return resolveOptions(def).find((o) => o.value === String(value))?.name ?? String(value);
}

/** A slider setting's limits, step, reset value and number format. */
export function sliderDef(id: SliderSettingId): SliderSettingDef {
  return settingDef(id) as SliderSettingDef;
}
