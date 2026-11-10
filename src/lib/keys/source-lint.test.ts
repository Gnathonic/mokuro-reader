/**
 * "Every key we map can be rebound" stays true only while no shortcut site
 * compares keys by hand. The files that used to (#55) may only match keys
 * through `dispatchKey`; the allowlist holds the element-level handlers that
 * legitimately stay outside the keymap (a field's Enter, a modal's own Escape
 * capture — docs/INPUT-CONTRACTS.md "Keyboard").
 */
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob<string>(
  [
    '/src/lib/components/Reader/{Reader,VerticalScrollReader,HorizontalScrollReader,PagedViewport,RereadPromptModal,QuickActions}.svelte',
    '/src/lib/components/Reader/Edit/EditToolbar.svelte',
    '/src/lib/components/Reader/Layers/LayerPicker.svelte',
    '/src/lib/components/{Catalog,CatalogItem,CatalogListItem,VolumeItem,NavBar}.svelte',
    '/src/lib/components/Series/SeriesEditorModal.svelte',
    '/src/lib/views/{SeriesView,ProgressTrackerView,VolumeTextView,SeriesTextView}.svelte',
    '/src/routes/+layout.svelte',
    '/src/lib/util/{delete-shortcut,series-editor-shortcut}.ts',
    '/src/lib/keys/{app-actions,providers,outside-reader}.ts'
  ],
  { query: '?raw', import: 'default', eager: true }
);

const MIGRATED = [
  'src/lib/components/Reader/Reader.svelte',
  'src/lib/components/Reader/VerticalScrollReader.svelte',
  'src/lib/components/Reader/HorizontalScrollReader.svelte',
  'src/lib/components/Reader/PagedViewport.svelte',
  'src/lib/components/Reader/RereadPromptModal.svelte',
  // The sites that gained a command handler in step B (spec 17.10).
  'src/lib/components/Reader/QuickActions.svelte',
  'src/lib/components/Reader/Edit/EditToolbar.svelte',
  'src/lib/components/Reader/Layers/LayerPicker.svelte',
  'src/lib/components/Catalog.svelte',
  'src/lib/components/NavBar.svelte',
  'src/lib/components/Series/SeriesEditorModal.svelte',
  'src/lib/views/ProgressTrackerView.svelte',
  'src/lib/views/VolumeTextView.svelte',
  'src/lib/views/SeriesTextView.svelte',
  'src/lib/keys/app-actions.ts',
  'src/lib/keys/providers.ts',
  'src/lib/keys/outside-reader.ts',
  'src/lib/components/CatalogItem.svelte',
  'src/lib/components/CatalogListItem.svelte',
  'src/lib/components/VolumeItem.svelte',
  'src/lib/views/SeriesView.svelte',
  'src/routes/+layout.svelte',
  'src/lib/util/delete-shortcut.ts',
  'src/lib/util/series-editor-shortcut.ts'
];

/** file → the exact lines allowed to compare a key, each an element-level handler. */
const ALLOWED: Record<string, string[]> = {
  // The page-number field's Enter.
  'src/lib/components/Reader/Reader.svelte': ["if (e.key === 'Enter') {"],
  // The re-read prompt's own Escape capture (a modal, outside the keymap).
  'src/lib/components/Reader/RereadPromptModal.svelte': ["if (e.key === 'Escape') {"],
  // The layer picker's own Escape (it opens without taking focus).
  'src/lib/components/Reader/Layers/LayerPicker.svelte': ["if (event.key === 'Escape') {"],
  // The series editor's own Escape capture (a dialog, outside the keymap).
  'src/lib/components/Series/SeriesEditorModal.svelte': ["if (e.key !== 'Escape') return;"]
};

const RAW_KEY_MATCH =
  /\b\w+\.(key|code)\s*(===|!==|==|!=)|switch\s*\(\s*\w+\.(key|code)\s*\)|\.(key|code)\s*\)\s*\?|includes\(\s*\w+\.(key|code)\s*\)/;

describe('no hand-written key matching outside the keymap', () => {
  it.each(MIGRATED)('%s', (file) => {
    const text = SOURCES[`/${file}`];
    expect(text, `${file} not found`).toBeTypeOf('string');
    const lines = text.split('\n');
    const offending = lines
      .map((line) => line.trim())
      .filter((line) => RAW_KEY_MATCH.test(line))
      .filter((line) => !(ALLOWED[file] ?? []).includes(line));
    expect(offending).toEqual([]);
  });
});

/**
 * ONE keyboard listener outside the reader (#55, spec 17.4). A view or a card
 * that resolved keys itself would be tried in whatever order the listeners
 * happened to attach — which is how a page-scope key used to beat the card
 * under the pointer. So every site outside the reader PROVIDES a typed
 * handler map (`providers.ts`) and only `+layout.svelte` dispatches.
 */
const PROVIDERS: [file: string, scope: string][] = [
  ['src/lib/components/Catalog.svelte', 'library'],
  ['src/lib/components/CatalogItem.svelte', 'library.series'],
  ['src/lib/components/CatalogListItem.svelte', 'library.series'],
  ['src/lib/components/VolumeItem.svelte', 'library.volume'],
  ['src/lib/views/SeriesView.svelte', 'series'],
  ['src/lib/views/ProgressTrackerView.svelte', 'tracker'],
  ['src/lib/views/VolumeTextView.svelte', 'text'],
  ['src/lib/views/SeriesTextView.svelte', 'text'],
  ['src/lib/components/Series/SeriesEditorModal.svelte', 'series-editor']
];

/** A handler map checked against its scope's ids: `satisfies Record<…ActionId…, KeyHandler>`. */
const TYPED_MAP = /satisfies Record<[^>]*ActionId[^>]*>?[^>]*, KeyHandler>/;

describe('one key listener outside the reader', () => {
  it.each(PROVIDERS)('%s provides %s and resolves no key itself', (file, scope) => {
    const text = SOURCES[`/${file}`];
    expect(text, `${file} not found`).toBeTypeOf('string');
    expect(text).toContain(`provideKeyHandlers('${scope}', {`);
    expect(TYPED_MAP.test(text), 'its map must be `satisfies Record<its ids, KeyHandler>`').toBe(
      true
    );
    expect(text).not.toContain('dispatchKey(');
    expect(text).not.toContain('OutsideReader(');
  });

  it('only the series card keeps a key listener, for its Shift / Alt modifier state', () => {
    const listening = PROVIDERS.map(([file]) => file).filter((file) =>
      /addEventListener\(\s*'key(down|up)'|<svelte:(window|document)[^>]*onkey/.test(
        SOURCES[`/${file}`]
      )
    );
    // CatalogItem: the shelf-alignment indicators. SeriesEditorModal: its Escape capture.
    expect(listening.sort()).toEqual([
      'src/lib/components/CatalogItem.svelte',
      'src/lib/components/Series/SeriesEditorModal.svelte'
    ]);
    const card = SOURCES['/src/lib/components/CatalogItem.svelte'];
    expect(card).toContain('updateModifierState(e)');
  });

  it('the layout dispatches, guarded once, and the reader stands down under a dialog', () => {
    const layout = SOURCES['/src/routes/+layout.svelte'];
    expect(layout).toContain('handleKeydownOutsideReader(event, {');
    expect(layout).not.toContain('dispatchKey(');
    const listener = SOURCES['/src/lib/keys/outside-reader.ts'];
    expect(listener).toContain('shortcutAllowed(event, document.activeElement)');
    expect(listener).toContain('dialogOpen: anyModalOpen()');
    expect(layout).toContain('satisfies Record<AppActionId, KeyHandler>');
    const reader = SOURCES['/src/lib/components/Reader/Reader.svelte'];
    expect(reader).toContain('if (anyModalOpen()) {');
    expect(reader).toContain(
      "satisfies Record<ReaderActionId | EditActionId | 'app.back', KeyHandler>"
    );
    // Both sites answer the shared app commands from the one map.
    expect(layout).toContain('...appKeyHandlers');
    expect(reader).toContain('appKeyHandlers as Partial<Record<string, KeyHandler>>');
    expect(SOURCES['/src/lib/keys/app-actions.ts']).toContain(
      'satisfies Record<AppCommandId, KeyHandler>'
    );
  });
});

/**
 * The quick menu is drawn from the registry (#55, spec 17.7). A button written
 * into the menu by hand would be an action the keys cannot reach, the section
 * cannot switch off and a profile cannot move; a row that derived the keymap
 * or the menu selection itself would do it once per row, 250 times.
 */
const SECTION_SOURCES = import.meta.glob<string>(
  '/src/lib/components/Settings/Keys/{KeyboardShortcuts,KeyActionRow,KeySettingRow}.svelte',
  { query: '?raw', import: 'default', eager: true }
);

describe('the quick menu and its section are registry-driven', () => {
  const menu = SOURCES['/src/lib/components/Reader/QuickActions.svelte'];
  const reader = SOURCES['/src/lib/components/Reader/Reader.svelte'];

  it('QuickActions draws its entries from the items it is given and owns no action', () => {
    expect(menu).toContain('{#each items as item (item.id)}');
    expect(menu).toContain('actionIcon(item.icon)');
    expect(menu).toContain('aria-label={item.label}');
    expect(menu).toContain('onRun?.(item.id)');
    // Its one hand-written label, and its one imported icon, are its own button's.
    expect([...menu.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'Quick actions menu'
    ]);
    const icons = /import \{([^}]*)\} from 'flowbite-svelte-icons'/.exec(menu)?.[1] ?? '';
    expect(
      icons
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ).toEqual(['PlusOutline']);
    expect(menu).not.toContain('toggleFullScreen');
    expect(menu).not.toContain('ankiConnectSettings');
  });

  it('the reader hands it ONE derived list and runs a tap through the keys’ resolver', () => {
    expect(reader).toContain('let quickMenuEntries = $derived.by(() => {');
    expect(reader).toContain('quickMenuItems(quickMenuIds(s.quickMenu, actions.values(), mode)');
    expect(reader).toContain('items={quickMenuEntries}');
    expect(reader).toContain('onRun={runAction}');
    expect(reader).toContain('resolveKey(id as ActionId, action)?.(');
    // Nothing of the old per-button wiring is left.
    for (const prop of ['onAnkiImage=', 'onZoomFit=', 'onEdit=', 'editEnabled=']) {
      expect(reader, prop).not.toContain(prop);
    }
  });

  it('the section derives what spans rows once; a row derives only its own chords', () => {
    const section = SECTION_SOURCES['/src/lib/components/Settings/Keys/KeyboardShortcuts.svelte'];
    const row = SECTION_SOURCES['/src/lib/components/Settings/Keys/KeyActionRow.svelte'];
    const setting = SECTION_SOURCES['/src/lib/components/Settings/Keys/KeySettingRow.svelte'];
    expect(section).toContain('let conflicts = $derived(findConflicts($keymap));');
    expect(section).toContain(
      'let menuIds = $derived(quickMenuIds(quickMenu, actionMap.values()));'
    );
    expect(section).toContain('let groups = $derived(groupTargets(targets, facts, filter));');
    // A closed group mounts no rows.
    expect(section).toContain('{#if groupOpen}');
    for (const [name, text] of [
      ['KeyActionRow', row],
      ['KeySettingRow', setting]
    ] as const) {
      for (const spanning of [
        'findConflicts(',
        'quickMenuIds(',
        'compileKeymap(',
        'groupTargets(',
        'buildTargets(',
        '$keymap',
        '$settings'
      ]) {
        expect(text, `${name} must not use ${spanning}`).not.toContain(spanning);
      }
    }
    // Action button rows stay clickable under the night-mode filter.
    expect(row).toContain('class="relative z-10 mt-1.5 flex flex-wrap items-center gap-2 text-xs"');
    expect(section).toContain('class="relative z-10 mt-2"');
  });
});

/**
 * One list, used twice (#55, spec 17.2): a bindable setting's options live in
 * `settings/setting-defs.ts` and nowhere else. A `{ value, name }` literal in
 * one of these components would be a second copy that the key actions never
 * see — a "Set to" for an option the select does not offer, or the reverse.
 */
const OPTION_SOURCES = import.meta.glob<string>(
  [
    '/src/lib/components/Settings/Reader/{ReaderSelects,ReaderSettings,ReaderToggles,PageAdjustCard}.svelte',
    '/src/lib/components/Settings/CatalogSettings.svelte',
    '/src/lib/views/ProgressTrackerView.svelte'
  ],
  { query: '?raw', import: 'default', eager: true }
);

const OPTION_FILES = [
  'src/lib/components/Settings/Reader/ReaderSelects.svelte',
  'src/lib/components/Settings/Reader/ReaderSettings.svelte',
  'src/lib/components/Settings/Reader/ReaderToggles.svelte',
  'src/lib/components/Settings/Reader/PageAdjustCard.svelte',
  'src/lib/components/Settings/CatalogSettings.svelte',
  'src/lib/views/ProgressTrackerView.svelte'
];

/** `{ value: …, name: … }` in either order, on one line or across a few. */
const OPTION_LITERAL = /\{\s*value:[^{}]*\bname:|\{\s*name:[^{}]*\bvalue:/;

describe('option lists come from the setting definitions', () => {
  it.each(OPTION_FILES)('%s holds no { value, name } option literal', (file) => {
    const text = OPTION_SOURCES[`/${file}`];
    expect(text, `${file} not found`).toBeTypeOf('string');
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(text)?.[1] ?? '';
    expect(OPTION_LITERAL.exec(script)?.[0] ?? null).toBeNull();
  });

  it('the pattern does catch an option literal', () => {
    expect(OPTION_LITERAL.test("{ value: 'auto', name: 'Match orientation' }")).toBe(true);
    expect(OPTION_LITERAL.test("{\n  value: 'a',\n  name: 'A'\n}")).toBe(true);
    expect(OPTION_LITERAL.test("listOptions<ScrollMode>('scroll-mode')")).toBe(false);
  });

  it.each([
    ['src/lib/components/Settings/Reader/ReaderSelects.svelte', 'listOptions('],
    ['src/lib/components/Settings/Reader/ReaderSettings.svelte', 'listOptions<'],
    ['src/lib/components/Settings/Reader/ReaderToggles.svelte', "listOptions<WheelMode>('wheel')"],
    ['src/lib/components/Settings/Reader/PageAdjustCard.svelte', "sliderDef('ink-strength')"],
    [
      'src/lib/components/Settings/CatalogSettings.svelte',
      "listOptions<CatalogStackingPreset>('stacking')"
    ],
    ['src/lib/views/ProgressTrackerView.svelte', "stepSetting('tracker-sort', 'next')"]
  ])('%s reads its lists from the definitions (%s)', (file, needle) => {
    expect(OPTION_SOURCES[`/${file}`]).toContain(needle);
  });
});
