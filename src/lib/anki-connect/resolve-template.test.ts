import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writable } from 'svelte/store';

vi.mock('$lib/settings', () => ({
  settings: writable({
    ankiConnectSettings: {
      url: 'http://127.0.0.1:8765',
      enabled: true,
      selectedModel: 'Basic',
      connectionData: null,
      // Saved configs (no connection data): the card functions need one per
      // mode to proceed; the tests pass their own field mappings.
      createModelConfigs: {
        Basic: { modelName: 'Basic', deckName: 'Default', fieldMappings: [] }
      },
      updateModelConfigs: {
        Basic: { modelName: 'Basic', deckName: 'Default', fieldMappings: [] }
      },
      cardMode: 'create'
    }
  }),
  DEFAULT_MODEL_CONFIGS: {}
}));

vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/platform', () => ({ isMobilePlatform: () => false }));

import {
  createCard,
  generateImageFilename,
  resolveDynamicTags,
  resolveTemplate,
  updateLastCard
} from './index';

const XSS = '<img src=x onerror=alert(1)>';
const XSS_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';

describe('resolveTemplate: normal cards', () => {
  it('substitutes every text variable', () => {
    expect(
      resolveTemplate(
        '{selection} | {sentence} | {series} | {volume} | {page_num} | {page_filename}',
        { seriesTitle: 'ダンジョン飯', volumeTitle: '第1巻' },
        '飯',
        'ダンジョン飯を食べる',
        { pageNumber: 12, pageFilename: '012.jpg' }
      )
    ).toBe('飯 | ダンジョン飯を食べる | ダンジョン飯 | 第1巻 | 12 | 012.jpg');
  });

  it('keeps the user template markup raw', () => {
    expect(
      resolveTemplate('<b>{selection}</b><br><span class="s">{sentence}</span>', {}, '猫', '猫だ')
    ).toBe('<b>猫</b><br><span class="s">猫だ</span>');
  });

  it('turns newlines in Japanese text into <br>', () => {
    expect(resolveTemplate('{sentence}', {}, undefined, '吾輩は猫である。\n名前はまだ無い。')).toBe(
      '吾輩は猫である。<br>名前はまだ無い。'
    );
  });

  it('empties variables with no value and returns null for an empty result', () => {
    expect(resolveTemplate('{selection}{series}{page_num}{existing}', {})).toBeNull();
    expect(resolveTemplate('{sentence} x', {}, undefined, undefined)).toBe('x');
  });

  it('returns null for picture-only templates', () => {
    expect(resolveTemplate('{image}', {})).toBeNull();
    expect(resolveTemplate('{cover}', {})).toBeNull();
    expect(resolveTemplate('', {})).toBeNull();
  });

  it('collapses runs of spaces but not newlines', () => {
    expect(resolveTemplate('  {selection}   x\t\ty  ', {}, '猫')).toBe('猫 x y');
  });

  it('page number 0 still resolves', () => {
    expect(resolveTemplate('p{page_num}', {}, undefined, undefined, { pageNumber: 0 })).toBe('p0');
  });
});

describe('resolveTemplate: reader-sourced values are text, never markup', () => {
  it('escapes HTML in OCR selection and sentence', () => {
    expect(resolveTemplate('{selection}<hr>{sentence}', {}, XSS, `a"b'c&d`)).toBe(
      `${XSS_ESCAPED}<hr>a&quot;b&#39;c&amp;d`
    );
  });

  it('escapes series, volume and page filename', () => {
    expect(
      resolveTemplate(
        '{series}/{volume}/{page_filename}',
        { seriesTitle: '<script>x()</script>', volumeTitle: '"><b>' },
        undefined,
        undefined,
        { pageFilename: '<svg onload=x>.png' }
      )
    ).toBe('&lt;script&gt;x()&lt;/script&gt;/&quot;&gt;&lt;b&gt;/&lt;svg onload=x&gt;.png');
  });

  it('a value cannot break out of a quoted attribute in the template', () => {
    expect(
      resolveTemplate('<span title="{sentence}">{sentence}</span>', {}, '', '" onmouseover="x')
    ).toBe('<span title="&quot; onmouseover=&quot;x">&quot; onmouseover=&quot;x</span>');
  });

  it('escapes before the newline conversion, so the only <br> are real line breaks', () => {
    expect(resolveTemplate('{sentence}', {}, undefined, '<br>一行目\n二行目')).toBe(
      '&lt;br&gt;一行目<br>二行目'
    );
  });

  it('inserts $-replacement patterns literally', () => {
    const value = "$& $` $' $1 $$";
    expect(resolveTemplate('A {selection} B', {}, value)).toBe('A $&amp; $` $&#39; $1 $$ B');
    expect(
      resolveTemplate('<i>{series}</i> tail', { seriesTitle: "$'$`" }, undefined, undefined)
    ).toBe('<i>$&#39;$`</i> tail');
  });

  it('never re-scans a substituted value for other variables', () => {
    expect(
      resolveTemplate('{selection}|{sentence}', { seriesTitle: 'S' }, '{sentence}{series}', 'real')
    ).toBe('{sentence}{series}|real');
  });

  it('OCR text spelling {existing} does not pull in the existing field', () => {
    expect(
      resolveTemplate('{sentence}', {}, undefined, 'a {existing} b', {
        previousValues: { Front: '<b>secret</b>' },
        fieldName: 'Front'
      })
    ).toBe('a {existing} b');
  });
});

describe('resolveTemplate: {existing}', () => {
  const opts = (value: string) => ({ previousValues: { Back: value }, fieldName: 'Back' });

  it('inserts the existing field raw, including HTML', () => {
    expect(
      resolveTemplate('{existing}<br>{sentence}', {}, undefined, '新しい', opts('<b>古い</b>'))
    ).toBe('<b>古い</b><br>新しい');
  });

  it('keeps newlines and spacing inside the existing value (a <style> block)', () => {
    const existing = '<style>\n  .a {  color: red; }\n</style>';
    expect(resolveTemplate('{existing}\n{sentence}', {}, undefined, '猫', opts(existing))).toBe(
      `${existing}<br>猫`
    );
  });

  it('inserts $-patterns in the existing value literally', () => {
    expect(resolveTemplate('x {existing} y', {}, undefined, undefined, opts("$& $' $1"))).toBe(
      "x $& $' $1 y"
    );
  });

  it('supports the variable more than once', () => {
    expect(resolveTemplate('{existing}|{existing}', {}, undefined, undefined, opts('E'))).toBe(
      'E|E'
    );
  });

  it('OCR text containing the placeholder token spelling is left as text', () => {
    for (const token of ['__MOKURO_EXISTING_0__', '__MOKURO_EXISTING_1__']) {
      expect(
        resolveTemplate('{existing} {sentence}', {}, undefined, token, opts('<i>old</i>'))
      ).toBe(`<i>old</i> ${token}`);
    }
  });

  it('draws a fresh random nonce for the token on every call', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    try {
      resolveTemplate('{existing}', {}, undefined, undefined, opts('v'));
      resolveTemplate('{existing}', {}, undefined, undefined, opts('v'));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('only the nonce-bearing token is restored', () => {
    const spy = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint32Array).fill(0xdeadbeef);
        return array;
      });
    try {
      // With the nonce pinned, the token is __MOKURO_EXISTING_deadbeefdeadbeef_0__;
      // the un-nonced spelling the old code used stays text.
      expect(
        resolveTemplate('{existing}|{sentence}', {}, undefined, '__MOKURO_EXISTING_0__', opts('E'))
      ).toBe('E|__MOKURO_EXISTING_0__');
    } finally {
      spy.mockRestore();
    }
  });

  it('is empty without previous values', () => {
    expect(resolveTemplate('{existing}{sentence}', {}, undefined, '猫')).toBe('猫');
  });
});

describe('resolveDynamicTags', () => {
  it('resolves series and volume with underscores', () => {
    expect(
      resolveDynamicTags('mokuro {series} {volume}', {
        seriesTitle: 'One Piece',
        volumeTitle: 'Vol 1'
      })
    ).toBe('mokuro One_Piece Vol_1');
  });

  it('drops variables with no title and tidies spaces', () => {
    expect(resolveDynamicTags('  a {series}  {volume} b ', {})).toBe('a b');
  });

  it('a title cannot inject markup into a tag or deck name', () => {
    expect(resolveDynamicTags('Mining::{series}', { seriesTitle: '<svg/onload=alert(1)>' })).toBe(
      'Mining::＜svg/onload=alert(1)＞'
    );
  });

  it('inserts $-patterns in a title literally', () => {
    expect(resolveDynamicTags('x {series} y', { seriesTitle: '$& $`' })).toBe('x $&_$` y');
  });
});

describe('resolveDynamicTags: {existing}', () => {
  it('replaces {existing} with the previous tags, literally', () => {
    expect(resolveDynamicTags('{existing} new', {}, ['a', '$&', "$'"])).toBe("a $& $' new");
  });

  it('removes {existing} when there are no previous tags', () => {
    expect(resolveDynamicTags('{existing} new', {}, [])).toBe('new');
  });

  it('leaves {existing} as written when no previous tags are given (create)', () => {
    expect(resolveDynamicTags('{existing} {series}', { seriesTitle: 'S' })).toBe('{existing} S');
  });

  it('never re-scans a value: an old tag or a title spelling a placeholder stays literal', () => {
    expect(
      resolveDynamicTags('{existing} {series}', { seriesTitle: '{volume}', volumeTitle: 'V' }, [
        '{series}'
      ])
    ).toBe('{series} {volume}');
  });
});

describe('generateImageFilename', () => {
  // AnkiConnect writes the picture as <img src="FILENAME"> without escaping,
  // so a filename must never carry a quote or an angle bracket.
  it('strips the characters that could leave the src attribute', () => {
    const name = generateImageFilename(
      { seriesTitle: '"><svg onload=x>', volumeTitle: 'V' },
      '"<b>.png'
    );
    expect(name).not.toMatch(/["<>]/);
    expect(name).toBe('mokuro_svg_onload=x_V_b.png.jpg');
  });
});

describe('cards sent to AnkiConnect', () => {
  const IMAGE = 'data:image/jpeg;base64,QUJD';
  let requests: Array<{ action: string; params: any }>;

  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { action, params } = JSON.parse(String(init.body));
        requests.push({ action, params });
        const results: Record<string, unknown> = {
          deckNames: ['Default'],
          modelNames: ['Basic'],
          modelFieldNames: ['Front', 'Back', 'Picture', 'Source'],
          createDeck: 1,
          addNote: 1,
          updateNoteFields: null,
          addTags: null
        };
        return { json: async () => ({ result: results[action], error: null }) };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createCard sends escaped OCR text, raw template markup and the picture untouched', async () => {
    await createCard(
      IMAGE,
      XSS,
      '一行目\n<b>二行目</b>',
      'mined',
      { seriesTitle: 'S', volumeTitle: 'V' },
      {
        fieldMappings: [
          { fieldName: 'Front', template: '<u>{selection}</u>' },
          { fieldName: 'Back', template: '{sentence}' },
          { fieldName: 'Picture', template: '{image}' },
          { fieldName: 'Source', template: '<i>{page_filename}</i>' }
        ],
        pageFilename: '<b>001.jpg',
        deckName: 'Default'
      }
    );

    const add = requests.find((r) => r.action === 'addNote');
    expect(add).toBeDefined();
    expect(add!.params.note.fields).toEqual({
      Front: `<u>${XSS_ESCAPED}</u>`,
      Back: '一行目<br>&lt;b&gt;二行目&lt;/b&gt;',
      Source: '<i>&lt;b&gt;001.jpg</i>'
    });
    expect(add!.params.note.picture).toHaveLength(1);
    const picture = add!.params.note.picture[0];
    expect(picture).toMatchObject({ data: 'QUJD', fields: ['Picture'] });
    // Only the shape matters here; the exact name carries a known, unrelated
    // double extension from generateImageFilename.
    expect(picture.filename).toMatch(/^mokuro_S_V_.*001.*\.jpg$/);
    expect(picture.filename).not.toMatch(/["<>]/);
    expect(add!.params.note.tags).toEqual(['mined']);
  });

  it('createCard resolves a raw tag and deck template exactly once', async () => {
    await createCard(
      IMAGE,
      '語',
      undefined,
      'mokuro {series} {volume}',
      { seriesTitle: "{volume} <x y='1'>", volumeTitle: 'V' },
      {
        fieldMappings: [{ fieldName: 'Front', template: '{selection}' }],
        deckName: 'Mining::{series}'
      }
    );

    const add = requests.find((r) => r.action === 'addNote');
    expect(add).toBeDefined();
    // The title's own `{volume}` is not expanded by a second pass.
    expect(add!.params.note.tags).toEqual(['mokuro', '{volume}_＜x_y=＇1＇＞', 'V']);
    expect(add!.params.note.deckName).toBe('Mining::{volume}_＜x_y=＇1＇＞');
  });

  it('updateLastCard keeps the existing field raw and escapes the new text', async () => {
    await updateLastCard(IMAGE, XSS, '{existing} {series}', { seriesTitle: 'A B' }, 42, 'Basic', {
      fieldMappings: [
        { fieldName: 'Front', template: '{existing}' },
        { fieldName: 'Back', template: '{existing}<br>{sentence}' }
      ],
      previousValues: { Front: '<b>語</b>', Back: '<i>old</i>' },
      previousTags: ['old', '{volume}']
    });

    const update = requests.find((r) => r.action === 'updateNoteFields');
    expect(update).toBeDefined();
    expect(update!.params.note.fields).toEqual({
      Front: '<b>語</b>',
      Back: `<i>old</i><br>${XSS_ESCAPED}`
    });
    // One pass: an old tag spelling `{volume}` is kept as written.
    const tags = requests.find((r) => r.action === 'addTags');
    expect(tags?.params.tags).toBe('old {volume} A_B');
  });

  it('updateLastCard escapes the page filename', async () => {
    await updateLastCard(IMAGE, '文', '', { seriesTitle: 'S' }, 42, 'Basic', {
      fieldMappings: [{ fieldName: 'Back', template: '{sentence} ({page_filename})' }],
      pageFilename: '"><img src=x onerror=alert(1)>.png'
    });

    const update = requests.find((r) => r.action === 'updateNoteFields');
    expect(update).toBeDefined();
    expect(update!.params.note.fields).toEqual({
      Back: `文 (&quot;&gt;${XSS_ESCAPED}.png)`
    });
  });
});
