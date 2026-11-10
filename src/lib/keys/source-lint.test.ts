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
    '/src/lib/components/Reader/{Reader,VerticalScrollReader,HorizontalScrollReader,PagedViewport,RereadPromptModal}.svelte',
    '/src/lib/components/{CatalogItem,CatalogListItem,VolumeItem}.svelte',
    '/src/lib/views/SeriesView.svelte',
    '/src/routes/+layout.svelte',
    '/src/lib/util/{delete-shortcut,series-editor-shortcut}.ts'
  ],
  { query: '?raw', import: 'default', eager: true }
);

const MIGRATED = [
  'src/lib/components/Reader/Reader.svelte',
  'src/lib/components/Reader/VerticalScrollReader.svelte',
  'src/lib/components/Reader/HorizontalScrollReader.svelte',
  'src/lib/components/Reader/PagedViewport.svelte',
  'src/lib/components/Reader/RereadPromptModal.svelte',
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
  'src/lib/components/Reader/RereadPromptModal.svelte': ["if (e.key === 'Escape') {"]
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
