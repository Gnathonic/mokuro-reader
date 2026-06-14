import { describe, expect, it } from 'vitest';
import { basicAuthHeader, utf8ToBase64 } from './base64';

function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

describe('utf8ToBase64', () => {
  it('matches btoa for plain ASCII', () => {
    expect(utf8ToBase64('user:password')).toBe(btoa('user:password'));
  });

  it('encodes Latin-1 range chars as UTF-8 (not Latin-1 like btoa)', () => {
    expect(utf8ToBase64('user:päss')).toBe('dXNlcjpww6Rzcw==');
    // btoa produces the Latin-1 encoding, which must differ
    expect(btoa('user:päss')).toBe('dXNlcjpw5HNz');
    expect(utf8ToBase64('user:päss')).not.toBe(btoa('user:päss'));
  });

  it('encodes a full Latin-1 password as UTF-8', () => {
    expect(utf8ToBase64('user:pässwörd')).toBe('dXNlcjpww6Rzc3fDtnJk');
  });

  it('encodes kana (chars > U+00FF) where btoa throws', () => {
    expect(utf8ToBase64('りんご')).toBe('44KK44KT44GU');
    expect(() => btoa('りんご')).toThrow();
  });

  it('encodes emoji surrogate pairs', () => {
    expect(utf8ToBase64('a:🔑key')).toBe('YTrwn5SRa2V5');
  });

  it('returns empty string for empty input', () => {
    expect(utf8ToBase64('')).toBe('');
  });

  it('round-trips long strings (exercises chunking)', () => {
    const input = 'é'.repeat(100000);
    expect(base64ToUtf8(utf8ToBase64(input))).toBe(input);
  });
});

describe('basicAuthHeader', () => {
  it('builds a Basic header with UTF-8 encoded credentials', () => {
    expect(basicAuthHeader('user', 'päss')).toBe('Basic dXNlcjpww6Rzcw==');
  });

  it('supports empty username (password-only auth)', () => {
    expect(basicAuthHeader('', 'pw')).toBe('Basic ' + btoa(':pw'));
  });
});
