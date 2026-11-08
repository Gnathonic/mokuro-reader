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
