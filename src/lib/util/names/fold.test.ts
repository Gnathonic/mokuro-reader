/**
 * Fold v2 as mokuro-bunko states it (`interop/contract/fold.json`, vendored in
 * `$lib/interop/contract/`): every vector, same and different pair and
 * series_key vector; the digest over every Unicode scalar value, which Bunko's
 * `names::tests` reproduces too; the bundled NFD/NFC against the engine's own
 * for every code point the engine has assigned; and, with a Bunko checkout
 * (`BUNKO_REPO`), that the vendored copies are Bunko's bytes.
 */
import { describe, expect, it } from 'vitest';
import fold from '#lib/interop/contract/fold.json';
import {
  FOLD_UCD,
  FOLD_VERSION,
  compareCodePoints,
  foldName,
  foldNameUncached,
  isFixedName,
  sameName,
  seriesKey,
  splitAtDots
} from './fold';
import { isDefaultIgnorable, nfc, nfd } from './normalize';
import {
  bunkoContractBytes,
  describeContractFile,
  sha256Stream,
  vendoredContractBytes
} from '#lib/interop/contract.js';

const VENDORED_FILES = ['fold-table.json', 'fold.json', 'sidecar-names.json'];

const show = (s: string) =>
  JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

describe('fold v2 (fold.json)', () => {
  it('is fold 2 on UCD 17.0.0, its table the bytes fold.json hashes', () => {
    expect(fold.fold).toBe(FOLD_VERSION);
    expect(fold.ucd).toBe(FOLD_UCD);
    expect(FOLD_UCD).toBe('17.0.0');
    const hash = sha256Stream();
    hash.update(vendoredContractBytes('fold-table.json'));
    expect(hash.hex()).toBe(fold.table_sha256);
  });

  it.each(fold.vectors.map((v) => [show(v.in), v] as const))(
    'F(%s)',
    (_, { in: input, out, why }) => {
      expect(foldName(input), why).toBe(out);
      expect(foldNameUncached(input), why).toBe(out);
      // Idempotent.
      expect(foldName(out), why).toBe(out);
    }
  );

  it.each(fold.same.map((v) => [show(v.a), show(v.b), v] as const))(
    '%s and %s are one entry',
    (_a, _b, { a, b, why }) => {
      expect(foldName(a), why).toBe(foldName(b));
      expect(sameName(a, b), why).toBe(true);
    }
  );

  it.each(fold.different.map((v) => [show(v.a), show(v.b), v] as const))(
    '%s and %s are two entries',
    (_a, _b, { a, b, why }) => {
      expect(foldName(a), why).not.toBe(foldName(b));
      expect(sameName(a, b), why).toBe(false);
    }
  );

  it.each(fold.series_key.map((v) => [show(v.in), v] as const))(
    'seriesKey(%s)',
    (_, { in: input, out, why }) => {
      expect(seriesKey(input), why).toBe(out);
    }
  );

  it("reproduces the digest: F(c), F('a'+c), F(c+U+0301) over every scalar value", () => {
    const hash = sha256Stream();
    let chunk = '';
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      chunk +=
        foldNameUncached(c) +
        '\n' +
        foldNameUncached('a' + c) +
        '\n' +
        foldNameUncached(c + '\u{301}') +
        '\n';
      if (chunk.length > 1 << 16) {
        hash.update(chunk);
        chunk = '';
      }
    }
    hash.update(chunk);
    expect(hash.hex()).toBe(fold.digest.sha256);
  }, 120_000);
});

describe('the bundled normalization', () => {
  it("is the engine's NFD and NFC for every code point the engine has assigned", () => {
    const unassigned = /\p{Cn}/u;
    const wrong: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (unassigned.test(c)) continue;
      for (const s of [c, c + '\u{301}', 'a' + c, c + '\u{334}\u{301}']) {
        if (nfd(s) !== s.normalize('NFD') || nfc(s) !== s.normalize('NFC')) {
          wrong.push(show(s));
        }
      }
      if (wrong.length > 20) break;
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('reorders marks and composes across a blocked one as UAX #15 says', () => {
    // dot below (220) sorts before dot above (230), and both compose onto s.
    expect(nfc('s\u{307}\u{323}')).toBe('\u{1e69}');
    expect(nfd('\u{1e69}')).toBe('s\u{323}\u{307}');
    // Hangul: algorithmic both ways.
    expect(nfd('\u{d55c}')).toBe('\u{1112}\u{1161}\u{11ab}');
    expect(nfc('\u{1112}\u{1161}\u{11ab}')).toBe('\u{d55c}');
    // A lone surrogate passes through.
    expect(nfc('a\ud800b')).toBe('a\ud800b');
  });
});

describe('fold helpers', () => {
  it('drops default-ignorable code points', () => {
    expect(isDefaultIgnorable(0x200b)).toBe(true);
    expect(isDefaultIgnorable(0xfeff)).toBe(true);
    expect(isDefaultIgnorable(0xe0100)).toBe(true);
    expect(isDefaultIgnorable(0x41)).toBe(false);
    expect(isDefaultIgnorable(0x600)).toBe(false);
  });

  it('recognises fixed names in every spelling the fold joins (R8)', () => {
    for (const name of ['series.json', 'SERIES.JSON', '\u{17f}eries.json', 'series\u{200b}.json']) {
      expect(isFixedName(name, 'series.json')).toBe(true);
    }
    expect(isFixedName('my-series.json', 'series.json')).toBe(false);
  });

  it('orders by code point, never by UTF-16 unit', () => {
    expect(compareCodePoints('\u{ff21}', '\u{1f600}')).toBeLessThan(0);
    // UTF-16 `<` says the opposite.
    expect('\u{ff21}' < '\u{1f600}').toBe(false);
    expect(compareCodePoints('\u{fe0f}', '\u{e0100}')).toBeLessThan(0);
    expect(compareCodePoints('a', 'b')).toBeLessThan(0);
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('x', 'x')).toBe(0);
  });

  it('cuts a name and its fold at the same dot', () => {
    expect(splitAtDots('V.ed\u{200b}IT.MoKuro', 1)).toEqual({
      raw: 'V.ed\u{200b}IT',
      rawRest: '.MoKuro',
      fold: 'v.edit',
      foldRest: '.mokuro'
    });
    expect(splitAtDots('Stra\u{df}e.EDIT.mokuro', 2)).toEqual({
      raw: 'Stra\u{df}e',
      rawRest: '.EDIT.mokuro',
      fold: 'strasse',
      foldRest: '.edit.mokuro'
    });
    expect(splitAtDots('.mokuro', 2)).toBeNull();
    expect(splitAtDots('none', 1)).toBeNull();
  });

  it('remembers non-ASCII folds without changing them', () => {
    const names = Array.from({ length: 12_000 }, (_, i) => `第${i}巻`);
    for (const name of names) expect(foldName(name)).toBe(foldNameUncached(name));
    for (const name of names.slice(0, 50)) expect(foldName(name)).toBe(name);
  });
});

describeContractFile('fold.json', 'the vendored fold v2 and rule 2 are Bunko’s bytes', () => {
  it.each(VENDORED_FILES)('%s', (file) => {
    const bunko = bunkoContractBytes(file);
    const ours = vendoredContractBytes(file);
    expect(ours.length).toBe(bunko.length);
    expect(ours.every((byte, i) => byte === bunko[i])).toBe(true);
  });
});
