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
 * Adding a shortcut is one entry here plus its handler at the listener site
 * that owns the state it touches (Reader.svelte's handler map is
 * `satisfies Record<...>`, so a reader/edit entry without a handler fails
 * type-check). A change in what an EXISTING action does (e.g. #283's
 * scroll-before-turn for Page Up/Down) is a change to its handler only.
 *
 * Default chords use `KeyboardEvent.code` (position, not character) — see
 * `chord.ts` for the format.
 */

/**
 * Where an action can fire, and which actions can conflict. The reader's
 * dispatch walks `edit` → `reader` → `app` while editing, so `edit` shadows
 * the other two (a note, not a conflict); the library scopes are per card
 * kind and never live at the same time.
 */
export type KeyScope = 'reader' | 'edit' | 'app' | 'library.series' | 'library.volume';

/**
 * Reader layouts. Continuous `auto` resolves to `vertical` or `horizontal`
 * the way `effectiveScrollMode` does in Reader.svelte.
 */
export type ReaderMode = 'paged' | 'vertical' | 'horizontal';

export type ActionGroup =
  'pages' | 'scrolling' | 'view' | 'ocr' | 'filters' | 'edit' | 'library' | 'general';

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
}

const ALL_MODES = ['paged', 'vertical', 'horizontal'] as const;
const PAGED_HORIZONTAL = ['paged', 'horizontal'] as const;
const CONTINUOUS = ['vertical', 'horizontal'] as const;

export const GROUP_LABELS: Record<ActionGroup, string> = {
  pages: 'Pages',
  scrolling: 'Scrolling',
  view: 'View',
  ocr: 'OCR',
  filters: 'Filters',
  edit: 'Edit mode',
  library: 'Library',
  general: 'General'
};

export const GROUP_ORDER: readonly ActionGroup[] = [
  'pages',
  'scrolling',
  'view',
  'ocr',
  'filters',
  'edit',
  'library',
  'general'
];

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
    repeat: false
  },
  {
    id: 'reader.zoom-fit',
    label: 'Zoom to fit',
    description: 'Show the whole page without changing the zoom mode.',
    group: 'view',
    scope: 'reader',
    modes: ['paged'],
    defaults: [],
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
    repeat: false
  },
  {
    id: 'reader.continuous',
    label: 'Continuous scroll',
    description: 'Switch between paged and continuous scroll.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyV'],
    repeat: false
  },
  {
    id: 'reader.offset-spreads',
    label: 'Offset spreads',
    description: 'Shift which pages pair up into a spread.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyO'],
    repeat: false
  },
  {
    id: 'reader.cover',
    label: 'First page is cover',
    description: 'Show the first page alone, as a cover.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyC'],
    repeat: false
  },
  {
    id: 'reader.dividers',
    label: 'Page dividers',
    description: 'Lines between pages in continuous scroll.',
    group: 'view',
    scope: 'reader',
    modes: CONTINUOUS,
    defaults: ['KeyM'],
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
    repeat: false
  },
  {
    id: 'reader.timer',
    label: 'Show/hide reading timer',
    description: 'The reading timer in the corner.',
    group: 'view',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: [],
    repeat: false
  },
  // ---- OCR ---------------------------------------------------------------
  {
    id: 'reader.ocr-always',
    label: 'Always show OCR',
    description: 'Keep the OCR text visible instead of on hover.',
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyT'],
    repeat: false
  },
  {
    id: 'reader.ocr-layer',
    label: 'Next OCR layer',
    description: "Cycle through the volume's OCR layers.",
    group: 'ocr',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyL'],
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
    repeat: false
  },
  // ---- Filters -----------------------------------------------------------
  {
    id: 'reader.invert',
    label: 'Invert colors',
    description: 'Toggle inverted page colors.',
    group: 'filters',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyI'],
    repeat: false
  },
  {
    id: 'reader.night',
    label: 'Night mode',
    description: 'Toggle the night mode tint.',
    group: 'filters',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyN'],
    repeat: false
  },
  {
    id: 'reader.grayscale',
    label: 'Black & white',
    description: 'Toggle black-and-white pages.',
    group: 'filters',
    scope: 'reader',
    modes: ALL_MODES,
    defaults: ['KeyG'],
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
    repeat: false
  },
  // ---- Library -----------------------------------------------------------
  {
    id: 'library.series-edit',
    label: 'Edit series',
    description: 'With a series card under the pointer: open the series editor.',
    group: 'library',
    scope: 'library.series',
    defaults: ['KeyE'],
    repeat: false
  },
  {
    id: 'library.series-remove',
    label: 'Remove series',
    description: 'With a series card under the pointer: remove the series.',
    group: 'library',
    scope: 'library.series',
    defaults: ['Delete'],
    repeat: false
  },
  {
    id: 'library.volume-edit',
    label: 'Edit volume',
    description: 'With a volume under the pointer: open the volume editor.',
    group: 'library',
    scope: 'library.volume',
    defaults: ['KeyE'],
    repeat: false
  },
  {
    id: 'library.volume-cover',
    label: 'Change cover',
    description: 'With a volume under the pointer: pick its cover.',
    group: 'library',
    scope: 'library.volume',
    defaults: ['KeyC'],
    repeat: false
  },
  {
    id: 'library.volume-remove',
    label: 'Remove from device',
    description: "With a volume under the pointer: remove this device's copy.",
    group: 'library',
    scope: 'library.volume',
    defaults: ['Delete'],
    repeat: false
  },
  {
    id: 'library.volume-delete-cloud',
    label: 'Delete cloud copy',
    description: 'With a volume under the pointer: delete its cloud copy.',
    group: 'library',
    scope: 'library.volume',
    defaults: ['Shift+Delete'],
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
    repeat: false
  }
] as const satisfies readonly KeyActionDef[];

type Entry = (typeof KEY_ACTIONS)[number];

export type ActionId = Entry['id'];
export type ReaderActionId = Extract<Entry, { scope: 'reader' }>['id'];
export type EditActionId = Extract<Entry, { scope: 'edit' }>['id'];
export type AppActionId = Extract<Entry, { scope: 'app' }>['id'];
export type LibrarySeriesActionId = Extract<Entry, { scope: 'library.series' }>['id'];
export type LibraryVolumeActionId = Extract<Entry, { scope: 'library.volume' }>['id'];

export const ACTIONS_BY_ID: ReadonlyMap<string, KeyActionDef> = new Map(
  KEY_ACTIONS.map((a) => [a.id, a as KeyActionDef])
);

export function isActionId(id: string): id is ActionId {
  return ACTIONS_BY_ID.has(id);
}

export function actionDef(id: ActionId): KeyActionDef {
  return ACTIONS_BY_ID.get(id)!;
}

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
