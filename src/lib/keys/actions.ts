/**
 * The keyboard action registry (#55) — every shortcut the app answers, as
 * data. One table drives the resolver (`dispatch.ts`), the settings section
 * (`components/Settings/Keys`) and every key hint in the UI, so a shortcut
 * can never be handled somewhere the table does not list, and a hint can
 * never name a key the user has rebound.
 *
 * Ids are PERMANENT: they are stored, per profile, in `profiles.json`
 * (`Settings.keyBindings`). Rename the label, never the id.
 *
 * This module holds the HAND-REGISTERED actions (commands and the mode-aware
 * cycles) and the scope table. A bindable SETTING is not an entry here: it is
 * a definition in `settings/setting-defs.ts`, from which `generate.ts` makes
 * its actions and `setting-actions.ts` handles all of them. `registry.ts`
 * joins the two into the full list.
 *
 * Adding a command is one entry here plus its handler at the site that owns
 * the state it touches: Reader.svelte's map for `reader` and `edit`,
 * `app-actions.ts` for `app`, and for every other scope the map its view,
 * card or dialog passes to `provideKeyHandlers` (`providers.ts`). Each map is
 * `satisfies Record<ScopeActionId<…>, KeyHandler>`, so an entry without a
 * handler fails type-check. A command's handler is its button's handler
 * behind its button's own test (spec 17.11). A change in what an EXISTING
 * action does (e.g. #283's scroll-before-turn for Page Up/Down) is a change
 * to its handler only.
 *
 * This file stays pure data — no stores, no components: the settings store
 * imports it (through `keymap.ts`) for the shape check of stored bindings.
 *
 * Default chords use `KeyboardEvent.code` (position, not character) — see
 * `chord.ts` for the format.
 */

import type { IconName } from './icon-names';

/**
 * Where an action can fire. `SCOPES` below says which scopes are live
 * together; `chordRelation` (keymap.ts) reads it.
 */
export type KeyScope =
  | 'edit'
  | 'reader'
  | 'library.series'
  | 'library'
  | 'library.volume'
  | 'series'
  | 'tracker'
  | 'text'
  | 'series-editor'
  | 'app';

export interface ScopeDef {
  /** Where the scope is live, for the settings section. */
  readonly label: string;
  /**
   * Scopes this one is tried BEFORE while both are live. Two actions on one
   * chord across such a pair are a note at capture, not a conflict.
   */
  readonly shadows: readonly KeyScope[];
  /** How the capture note starts: "While a volume is under the pointer". */
  readonly when?: string;
  /** Live only under a dialog, where `app` is not dispatched. */
  readonly dialog?: true;
}

/**
 * The scope table (spec 17.4). Order of trying: `edit`, `reader`, `app` in
 * the reader; the hovered card's scope, the view's scope, `app` elsewhere.
 * `app` is live with every scope that is not a dialog's; scopes that name
 * neither each other nor `app` are never live together.
 */
export const SCOPES: Record<KeyScope, ScopeDef> = {
  edit: { label: 'Edit mode', shadows: ['reader', 'app'], when: 'In edit mode' },
  reader: { label: 'Reader', shadows: [] },
  'library.series': {
    label: 'Series card under the pointer',
    shadows: ['library'],
    when: 'While a series card is under the pointer'
  },
  library: { label: 'Library', shadows: [] },
  'library.volume': {
    label: 'Volume under the pointer',
    shadows: ['series'],
    when: 'While a volume is under the pointer'
  },
  series: { label: 'Series page', shadows: [] },
  tracker: { label: 'Progress tracker', shadows: [] },
  text: { label: 'Text view', shadows: [] },
  'series-editor': { label: 'Series editor', shadows: [], dialog: true },
  app: { label: 'Everywhere', shadows: [] }
};

/**
 * Reader layouts. Continuous `auto` resolves to `vertical` or `horizontal`
 * the way `effectiveScrollMode` does in Reader.svelte.
 */
export type ReaderMode = 'paged' | 'vertical' | 'horizontal';

export type ActionGroup =
  'pages' | 'scrolling' | 'view' | 'ocr' | 'filters' | 'edit' | 'library' | 'general' | 'other';

/** What a generated action does to its setting (spec 17.2). */
export type SettingOp = 'toggle' | 'next' | 'prev' | 'to' | 'up' | 'down' | 'reset';

export interface KeyActionDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: ActionGroup;
  readonly scope: KeyScope;
  /** Reader layouts the action is live in (reader/edit scopes); absent = all. */
  readonly modes?: readonly ReaderMode[];
  /** Default chords. For a `locked` action these are the EXTRAS beside the lock. */
  readonly defaults: readonly string[];
  /** Fires on key auto-repeat (held key). Toggles and navigation-away never do. */
  readonly repeat: boolean;
  /** Chords that are always bound and cannot be removed (Escape on Back). */
  readonly locked?: readonly string[];
  /** The flowbite-svelte-icons NAME; `icons.ts` maps it to the component. */
  readonly icon: IconName;
  /**
   * May the action be put on the reader's quick menu? `off` = yes, and it is
   * off until the profile turns it on (or the default list names it);
   * `never` = it has no switch. Only `reader`, `edit` and `app` actions are
   * ever eligible.
   */
  readonly menu: 'off' | 'never';
  /**
   * Set on an action GENERATED from a setting definition
   * (`settings/setting-defs.ts`): which definition, what it does to it and,
   * for a "Set to", the stored value. `setting-actions.ts` is the one handler.
   */
  readonly setting?: { readonly def: string; readonly op: SettingOp; readonly value?: string };
  /**
   * The definition a list's or slider's actions fold under in the settings
   * section. A toggle is its own row and has none.
   */
  readonly parent?: string;
}

const ALL_MODES = ['paged', 'vertical', 'horizontal'] as const;
const PAGED_HORIZONTAL = ['paged', 'horizontal'] as const;

export const GROUP_LABELS: Record<ActionGroup, string> = {
  pages: 'Pages',
  scrolling: 'Scrolling',
  view: 'View',
  ocr: 'OCR',
  filters: 'Filters',
  edit: 'Edit mode',
  library: 'Library',
  general: 'General',
  other: 'Other views'
};

export const GROUP_ORDER: readonly ActionGroup[] = [
  'pages',
  'scrolling',
  'view',
  'ocr',
  'filters',
  'edit',
  'library',
  'general',
  'other'
];

/**
 * The HAND-REGISTERED actions: commands and the mode-aware cycles (P, Z, L).
 * The full list every consumer works from is this tuple, then the actions
 * generated from the setting definitions, then one "Set to" per profile —
 * `registry.ts`. A compiled keymap carries the list it was built from.
 */
export const KEY_ACTIONS = [
  // ---- Pages -------------------------------------------------------------
  {
    id: 'reader.page-left',
    label: 'Page left',
    description: 'Turn toward the left. In a right-to-left book that is the next page.',
    group: 'pages',
    scope: 'reader',
    modes: PAGED_HORIZONTAL,
    defaults: ['ArrowLeft'],
    icon: 'ArrowLeftOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.page-right',
    label: 'Page right',
    description: 'Turn toward the right. In a right-to-left book that is the previous page.',
    group: 'pages',
    scope: 'reader',
    modes: PAGED_HORIZONTAL,
    defaults: ['ArrowRight'],
    icon: 'ArrowRightOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.page-prev',
    label: 'Previous page',
    description: 'Back one page or spread in reading order.',
    group: 'pages',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['PageUp'],
    icon: 'ChevronLeftOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.page-next',
    label: 'Next page',
    description: 'Forward one page or spread in reading order.',
    group: 'pages',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['PageDown', 'Space'],
    icon: 'ChevronRightOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.page-first',
    label: 'First page',
    description: 'Jump to the first page of the volume.',
    group: 'pages',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['Home'],
    icon: 'ChevronDoubleLeftOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.page-last',
    label: 'Last page',
    description: 'Jump to the last page of the volume.',
    group: 'pages',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['End'],
    icon: 'ChevronDoubleRightOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.volume-prev',
    label: 'Previous volume',
    description: 'Open the previous volume of the series.',
    group: 'pages',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'BackwardStepOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.volume-next',
    label: 'Next volume',
    description: 'Open the next volume of the series.',
    group: 'pages',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'ForwardStepOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.goto-page',
    label: 'Go to page…',
    description: 'Open the page number field: type a page and press Enter.',
    group: 'pages',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'FileSearchOutline',
    menu: 'off',
    repeat: false
  },
  // ---- Scrolling ---------------------------------------------------------
  {
    id: 'reader.scroll-up',
    label: 'Scroll up',
    description: 'Paged: pan a zoomed page up. Vertical: scroll up, or turn back at fit-to-screen.',
    group: 'scrolling',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['ArrowUp'],
    icon: 'ArrowUpOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.scroll-down',
    label: 'Scroll down',
    description:
      'Paged: pan a zoomed page down. Vertical: scroll down, or turn forward at fit-to-screen.',
    group: 'scrolling',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['ArrowDown'],
    icon: 'ArrowDownOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.scroll-left',
    label: 'Scroll left',
    description: 'Scroll a wide page left in vertical scroll.',
    group: 'scrolling',
    scope: 'reader',
    modes: ['vertical'],
    defaults: ['ArrowLeft'],
    icon: 'AngleLeftOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.scroll-right',
    label: 'Scroll right',
    description: 'Scroll a wide page right in vertical scroll.',
    group: 'scrolling',
    scope: 'reader',
    modes: ['vertical'],
    defaults: ['ArrowRight'],
    icon: 'AngleRightOutline',
    menu: 'off',
    repeat: true
  },
  // ---- View --------------------------------------------------------------
  {
    id: 'reader.fullscreen',
    label: 'Fullscreen',
    description: 'Enter or leave fullscreen.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyF'],
    icon: 'ExpandOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.zoom-mode',
    label: 'Cycle zoom mode',
    description: 'Fit to screen, fit to width, fill, original size, keep zoom.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyZ'],
    icon: 'ZoomInOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.zoom-fit',
    label: 'Zoom to fit',
    // Paged: a transient whole-page view, the mode setting untouched.
    // Continuous has no transient view: it sets the zoom mode to fit.
    description: 'Show the whole page. In continuous scroll this sets the zoom mode to fit.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'MinimizeOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.page-mode',
    label: 'Cycle page mode',
    description: 'Single, dual, auto. In continuous scroll: the scroll direction.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyP'],
    icon: 'BookOpenOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.offset-spreads',
    label: 'Spreads offset',
    // The one action for the spread pairing. Hand-registered, not generated
    // from the volume's "first page is cover" setting: its handler also steps
    // the progress so the page on screen stays on screen.
    description: 'Shift which pages pair up into a spread.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyO'],
    icon: 'BookOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.controls',
    label: 'Show/hide reader controls',
    description: 'What a tap on the page does: the page number, buttons and timer.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'EyeOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.zoom-in',
    label: 'Zoom in',
    description: 'One zoom step in, at the centre of the screen.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'ZoomInOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.zoom-out',
    label: 'Zoom out',
    description: 'One zoom step out, at the centre of the screen.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'ZoomOutOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'reader.quick-menu',
    label: 'Open quick menu',
    description: 'Open or close the quick actions menu, also while its button is hidden.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'DotsVerticalOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'reader.timer-pause',
    label: 'Pause or resume the timer',
    description: 'What a click on the reading timer does: stop or resume counting time.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'CirclePauseOutline',
    menu: 'off',
    repeat: false
  },
  // ---- OCR ---------------------------------------------------------------
  {
    id: 'reader.ocr-layer',
    label: 'Next OCR layer',
    description: "Cycle through the volume's OCR layers.",
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyL'],
    icon: 'LayersOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.ocr-layer-prev',
    label: 'Previous OCR layer',
    description: "Cycle through the volume's OCR layers, backwards.",
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'LayersOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.ocr-layers',
    label: 'OCR layers',
    description: 'Open the OCR layer picker.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'LayersOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.ocr-layer-primary',
    label: 'Set OCR layer to primary',
    description: "Show the volume's primary OCR.",
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'LayersOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.copy-page-text',
    label: 'Copy page text',
    description: 'Copy the text of the page or spread on screen, in reading order.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'FileCopyOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.anki-image',
    label: 'Add image to Anki',
    description: 'Pick a text box on the page and make an Anki card from it.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'ImageOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.anki-image-2',
    label: 'Add image 2 to Anki',
    description: "The same, for a spread's second page.",
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'ImageOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'reader.edit-mode',
    label: 'Edit OCR text',
    description: 'Enter or leave OCR edit mode (paged mode only).',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyE'],
    icon: 'PenOutline',
    menu: 'off',
    repeat: false
  },
  // The layer commands act on the DISPLAYED layer, under the picker's own rules.
  {
    id: 'layer.new',
    label: 'New layer…',
    description: 'Create an OCR layer: a copy of what is on screen, or an empty one.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'CirclePlusOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'layer.rename',
    label: 'Rename layer…',
    description: 'Rename the OCR layer on screen.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'EditOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'layer.promote',
    label: 'Promote layer to primary',
    description: "Make the OCR layer on screen the volume's primary OCR. Asks first.",
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'ArrowUpOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'layer.publish',
    label: 'Publish corrections',
    description: 'Publish your corrections layer as the shared corrections. Asks first.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'UploadOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'layer.unpublish',
    label: 'Unpublish shared corrections',
    description: 'Remove the shared corrections for everyone. Asks first.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'CloseCircleOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'layer.copy-to-edit',
    label: 'Copy layer to your corrections',
    description: 'Replace your corrections layer with the layer on screen. Asks first.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'FileCopyOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'layer.export',
    label: 'Export layer',
    description: 'Download the OCR layer on screen as a .mokuro file.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'DownloadOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'layer.delete',
    label: 'Delete layer',
    description: 'Delete the OCR layer on screen. Asks first.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    icon: 'TrashBinOutline',
    menu: 'off',
    repeat: false
  },
  // ---- Edit mode ---------------------------------------------------------
  {
    id: 'edit.undo',
    label: 'Undo',
    description: 'Undo the last OCR edit.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: ['Ctrl+KeyZ', 'Meta+KeyZ'],
    icon: 'UndoOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    description: 'Redo the last undone OCR edit.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: ['Ctrl+Shift+KeyZ', 'Shift+Meta+KeyZ', 'Ctrl+KeyY', 'Meta+KeyY'],
    icon: 'RedoOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'edit.delete',
    label: 'Delete selected boxes',
    description: 'Delete the selected text boxes. Without a selection the key does nothing here.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: ['Delete', 'Backspace'],
    icon: 'TrashBinOutline',
    menu: 'off',
    repeat: true
  },
  {
    id: 'edit.back',
    label: 'Step back',
    description: 'Leave the draw tool, then clear the selection, then leave edit mode.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: [],
    locked: ['Escape'],
    icon: 'CloseOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'edit.draw-tool',
    label: 'Draw new box',
    description: 'Arm or disarm the draw tool: the next drag on the page draws a text box.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: [],
    icon: 'DrawSquareOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'edit.merge',
    label: 'Merge boxes',
    description: 'Merge the selected text boxes into one.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: [],
    icon: 'MergeCellsOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'edit.split',
    label: 'Split box',
    description: 'Split the selected box before the line chosen inside it.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: [],
    icon: 'SplitCellsOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'edit.place-lines',
    label: 'Place lines',
    description: 'Give the selected box one positionable line per OCR line.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: [],
    icon: 'AlignJustifyOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'edit.flip',
    label: 'Flip writing mode',
    description: 'Switch the selected boxes between vertical and horizontal text.',
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: [],
    icon: 'SortHorizontalOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'edit.revert-page',
    label: 'Revert page',
    description: "Restore the page's original OCR. Undo brings the edits back.",
    group: 'edit',
    scope: 'edit',
    modes: ['paged'],
    defaults: [],
    icon: 'RefreshOutline',
    menu: 'off',
    repeat: false
  },
  // ---- Library -----------------------------------------------------------
  {
    id: 'library.focus-search',
    label: 'Focus search',
    description: 'On the catalog: put the cursor in the search field.',
    group: 'library',
    scope: 'library',
    defaults: [],
    icon: 'SearchOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.series-open',
    label: 'Open series',
    description: 'With a series card under the pointer: open its page.',
    group: 'library',
    scope: 'library.series',
    defaults: [],
    icon: 'BookOpenOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.series-edit',
    label: 'Edit series',
    description: 'With a series card under the pointer: open the series editor.',
    group: 'library',
    scope: 'library.series',
    defaults: ['KeyE'],
    icon: 'EditOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.series-remove',
    label: 'Remove series',
    description: 'With a series card under the pointer: remove the series.',
    group: 'library',
    scope: 'library.series',
    defaults: ['Delete'],
    icon: 'TrashBinOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-edit',
    label: 'Edit volume',
    description: 'With a volume under the pointer: open the volume editor.',
    group: 'library',
    scope: 'library.volume',
    defaults: ['KeyE'],
    icon: 'EditOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-cover',
    label: 'Change cover',
    description: 'With a volume under the pointer: pick its cover.',
    group: 'library',
    scope: 'library.volume',
    defaults: ['KeyC'],
    icon: 'ImageOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-remove',
    label: 'Remove from device',
    description: "With a volume under the pointer: remove this device's copy.",
    group: 'library',
    scope: 'library.volume',
    defaults: ['Delete'],
    icon: 'TrashBinOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-delete-cloud',
    label: 'Delete cloud copy',
    description: 'With a volume under the pointer: delete its cloud copy.',
    group: 'library',
    scope: 'library.volume',
    defaults: ['Shift+Delete'],
    icon: 'TrashBinOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-open',
    label: 'Open volume',
    description:
      'With a volume under the pointer: open it in the reader, or download it when it is not on this device.',
    group: 'library',
    scope: 'library.volume',
    defaults: [],
    icon: 'BookOpenReaderOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-read',
    label: 'Mark volume read or unread',
    description: 'With a volume under the pointer: mark it read, or unread when it already is.',
    group: 'library',
    scope: 'library.volume',
    defaults: [],
    icon: 'CheckCircleOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-download',
    label: 'Download volume',
    description: 'With a volume under the pointer: download it from the cloud.',
    group: 'library',
    scope: 'library.volume',
    defaults: [],
    icon: 'CloudArrowUpOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-backup',
    label: 'Back up volume',
    description:
      'With a volume under the pointer: back it up to the cloud, or retry a failed upload. Never deletes.',
    group: 'library',
    scope: 'library.volume',
    defaults: [],
    icon: 'CloudArrowUpOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-text',
    label: 'View volume text',
    description: 'With a volume under the pointer: open its text view.',
    group: 'library',
    scope: 'library.volume',
    defaults: [],
    icon: 'FileLinesOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'library.volume-extract',
    label: 'Extract volume…',
    description: 'With a volume under the pointer: export it as a file.',
    group: 'library',
    scope: 'library.volume',
    defaults: [],
    icon: 'FileLinesOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series.edit',
    label: 'Edit this series',
    description: 'On a series page: open the series editor.',
    group: 'library',
    scope: 'series',
    defaults: [],
    icon: 'EditOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series.download-all',
    label: 'Download all volumes',
    description: 'On a series page: download every volume that is not on this device.',
    group: 'library',
    scope: 'series',
    defaults: [],
    icon: 'DownloadOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series.backup',
    label: 'Back up series',
    description: 'On a series page: back up the volumes the cloud does not have yet.',
    group: 'library',
    scope: 'series',
    defaults: [],
    icon: 'DownloadOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series.remove',
    label: 'Remove manga',
    description: 'On a series page: remove the series from this device. Asks first.',
    group: 'library',
    scope: 'series',
    defaults: [],
    icon: 'TrashBinOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series.delete-cloud',
    label: 'Delete series from cloud',
    description: 'On a series page: delete the cloud copy of the series. Asks first.',
    group: 'library',
    scope: 'series',
    defaults: [],
    icon: 'TrashBinOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series.clean-duplicates',
    label: 'Clean cloud duplicates',
    description: 'On a series page: remove duplicate cloud files of the series. Asks first.',
    group: 'library',
    scope: 'series',
    defaults: [],
    icon: 'TrashBinOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series.extract',
    label: 'Extract series…',
    description: 'On a series page: export its volumes as files.',
    group: 'library',
    scope: 'series',
    defaults: [],
    icon: 'FileExportOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series.text',
    label: 'View series text',
    description: 'On a series page: open the text of the whole series.',
    group: 'library',
    scope: 'series',
    defaults: [],
    icon: 'FileExportOutline',
    menu: 'never',
    repeat: false
  },
  // ---- General -----------------------------------------------------------
  {
    id: 'app.back',
    label: 'Back',
    description: 'Close the reader or leave the page. Escape always works; add extra keys.',
    group: 'general',
    scope: 'app',
    defaults: [],
    locked: ['Escape'],
    icon: 'CloseOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'app.settings',
    label: 'Open settings',
    description: 'Open the settings panel.',
    group: 'general',
    scope: 'app',
    defaults: [],
    icon: 'CogOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'app.sync',
    label: 'Sync progress now',
    description: 'Sync read progress with the connected cloud storage.',
    group: 'general',
    scope: 'app',
    defaults: [],
    icon: 'RefreshOutline',
    menu: 'off',
    repeat: false
  },
  {
    id: 'app.open-catalog',
    label: 'Open catalog',
    description: 'Go to the catalog.',
    group: 'general',
    scope: 'app',
    defaults: [],
    icon: 'HomeOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'app.open-reading-speed',
    label: 'Open reading speed',
    description: 'Go to the reading speed page.',
    group: 'general',
    scope: 'app',
    defaults: [],
    icon: 'ChartLineUpOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'app.open-progress-tracker',
    label: 'Open progress tracker',
    description: 'Go to the progress tracker.',
    group: 'general',
    scope: 'app',
    defaults: [],
    icon: 'CalendarMonthOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'app.open-upload',
    label: 'Open upload',
    description: 'Open the upload dialog.',
    group: 'general',
    scope: 'app',
    defaults: [],
    icon: 'UploadOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'app.open-cloud',
    label: 'Open cloud storage',
    description: 'Go to the cloud storage page.',
    group: 'general',
    scope: 'app',
    defaults: [],
    icon: 'CloudArrowUpOutline',
    menu: 'never',
    repeat: false
  },
  // ---- Other views: the series editor dialog, the tracker, the text views ---
  {
    id: 'series-editor.next-unlinked',
    label: 'Next unlinked series',
    description: 'In the series editor: go to the next series without an AniList link.',
    group: 'other',
    scope: 'series-editor',
    defaults: [],
    icon: 'ForwardOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'series-editor.next-untitled',
    label: 'Next series without titles',
    description: 'In the series editor: go to the next series with no alternative titles.',
    group: 'other',
    scope: 'series-editor',
    defaults: [],
    icon: 'ForwardOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'tracker.current-period',
    label: 'Back to the current period',
    description: 'On the progress tracker: leave a closed period for the current one.',
    group: 'other',
    scope: 'tracker',
    defaults: [],
    icon: 'CalendarMonthOutline',
    menu: 'never',
    repeat: false
  },
  {
    id: 'text.copy',
    label: 'Copy all text',
    description: 'In a text view: copy the whole text.',
    group: 'other',
    scope: 'text',
    defaults: [],
    icon: 'ClipboardOutline',
    menu: 'never',
    repeat: false
  }
] as const satisfies readonly KeyActionDef[];

type Entry = (typeof KEY_ACTIONS)[number];

/**
 * Seven actions that exist since the first build ARE a setting's toggle. They
 * are generated from their definition like any other toggle, but keep the id
 * stored bindings already use, and their default key (spec 17.3).
 */
export const PINNED_ACTIONS = {
  'reader.continuous': {
    defaults: ['KeyV'],
    description: 'Switch between paged and continuous scroll.'
  },
  'reader.dividers': {
    defaults: ['KeyM'],
    description: 'Lines between pages in continuous scroll.'
  },
  'reader.timer': { defaults: [], description: 'The reading timer in the corner.' },
  'reader.ocr-always': {
    defaults: ['KeyT'],
    description: 'Keep the OCR text visible instead of on hover.'
  },
  'reader.invert': { defaults: ['KeyI'], description: 'Toggle inverted page colors.' },
  'reader.night': { defaults: ['KeyN'], description: 'Toggle the night mode tint.' },
  'reader.grayscale': { defaults: ['KeyG'], description: 'Toggle black-and-white pages.' }
} as const satisfies Record<string, { defaults: readonly string[]; description: string }>;

export type HandActionId = Entry['id'];
export type PinnedActionId = keyof typeof PINNED_ACTIONS;
/** `set.<def>.toggle | .next | .prev | .to.<stored value> | .up | .down | .reset`. */
export type GeneratedActionId = `set.${string}`;

export type ActionId = HandActionId | PinnedActionId | GeneratedActionId;
/**
 * The hand-registered ids of one scope. Every listener site's handler map is
 * `satisfies Record<ScopeActionId<…>, KeyHandler>`, so an entry here without
 * a handler at its site fails type-check.
 */
export type ScopeActionId<S extends KeyScope> = Extract<Entry, { scope: S }>['id'];
export type ReaderActionId = ScopeActionId<'reader'>;
export type EditActionId = ScopeActionId<'edit'>;
export type AppActionId = ScopeActionId<'app'>;
/** The app actions every site answers the same way (`app-actions.ts`); Back is each site's own. */
export type AppCommandId = Exclude<AppActionId, 'app.back'>;
export type LibrarySeriesActionId = ScopeActionId<'library.series'>;
export type LibraryVolumeActionId = ScopeActionId<'library.volume'>;

/** Whether `action` can fire in reader layout `mode` (undefined = outside the reader). */
export function isLiveIn(action: KeyActionDef, mode: ReaderMode | undefined): boolean {
  if (!mode || !action.modes) return true;
  return action.modes.includes(mode);
}

/**
 * Keys and gestures that are NOT rebindable (spec section 2), listed
 * read-only in the settings section so "every key" can be checked there.
 */
export const FIXED_INPUTS: readonly { input: string; does: string }[] = [
  { input: 'Tap / click the page', does: 'Show or hide the reader controls' },
  { input: 'Double-tap a text box', does: 'Anki card capture' },
  { input: 'Drag on a text box (mouse, pen)', does: 'Select text for a dictionary' },
  { input: 'Drag, pinch, double-tap the page', does: 'Pan and zoom' },
  { input: 'Swipe (Mobile setting)', does: 'Turn the page at the edge of a zoomed page' },
  { input: 'Ctrl + wheel, trackpad pinch', does: 'Zoom' },
  { input: 'Ctrl + Shift + wheel', does: 'Page gap' },
  { input: 'Shift / Alt + wheel on a series card', does: 'Shelf alignment' },
  { input: 'Shift + right-click a spine', does: 'Shelf alignment' },
  { input: 'Enter, Escape, Backspace in a text field', does: 'Edit the field' },
  { input: 'Escape in a dialog', does: 'Close the dialog' },
  { input: '← → on the spine shelf', does: 'Move between spines' }
];
