/**
 * The contract helper's own rules: a Bunko checkout named by `BUNKO_REPO` must be
 * there and hold the baseline, one found by looking around must hold the contract the tests read, records are only ever written into one named that way, and Bunko's time
 * sentinels rebase in the format they were written in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_BASELINE,
  contractDir,
  findSiblingContract,
  fixtureFetch,
  namedContract,
  rebase,
  recordRequest,
  type Fixture,
  type Seed
} from './contract';
import { basicAuthHeader } from '$lib/util/base64';

/** A file test over a fake checkout holding `files` under `<root>/interop/contract/`. */
function holding(root: string, files: string[]) {
  const present = new Set(['seed.json', ...files].map((f) => `${root}/interop/contract/${f}`));
  return (path: string) => present.has(path);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the contract helper', () => {
  it('a BUNKO_REPO without interop/contract is an error, not a quiet skip', () => {
    vi.stubEnv('BUNKO_REPO', '/nonexistent/bunko-checkout');
    expect(() => contractDir()).toThrow(/BUNKO_REPO=\/nonexistent\/bunko-checkout/);
  });

  it('a BUNKO_REPO short of the baseline fails once, naming every missing file', () => {
    // Named by hand, an old checkout is still a mistake: say so up front, not
    // as scattered fixture errors in whichever tests read the missing files.
    const kept = ['sidecar-names.json', 'bunko/history-put.json'];
    const missing = CONTRACT_BASELINE.filter((rel) => !kept.includes(rel));
    let message = '';
    try {
      namedContract('/short', holding('/short', kept));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('BUNKO_REPO=/short');
    expect(message).toContain(`lacks ${missing.join(', ')}.`);
    for (const rel of kept) expect(message).not.toContain(rel);

    // Complete, the same checkout is the contract.
    expect(namedContract('/full', holding('/full', CONTRACT_BASELINE))).toBe(
      '/full/interop/contract'
    );
    // And without seed.json it is no checkout at all.
    expect(() => namedContract('/none', () => false)).toThrow(
      /has no interop\/contract\/seed.json/
    );
  });

  it('a sibling found by looking around counts only when it holds the contract these tests read', () => {
    // A checkout on an older branch (0.7: no seal vectors, no history or
    // corrections fixtures) is not this reader's contract: running against it
    // fails ordinary unit tests on fixtures it never had.
    const exists = (path: string) =>
      holding('/old', ['bunko/marker-active.json'])(path) ||
      holding('/new', CONTRACT_BASELINE)(path);
    expect(findSiblingContract(['/old'], exists)).toEqual({
      dir: null,
      stale: ['/old/interop/contract']
    });
    expect(findSiblingContract(['/none', '/old', '/new'], exists)).toEqual({
      dir: '/new/interop/contract',
      stale: ['/old/interop/contract']
    });
    expect(findSiblingContract(['/none'], exists)).toEqual({ dir: null, stale: [] });
  });

  it('READER_BLESS=1 writes only into a checkout named by BUNKO_REPO', () => {
    vi.stubEnv('BUNKO_REPO', undefined);
    vi.stubEnv('READER_BLESS', '1');
    expect(() =>
      recordRequest('anything', {
        request: { method: 'GET', url: 'https://bunko.example/' },
        expect: { status: [200] }
      })
    ).toThrow(/needs BUNKO_REPO/);
  });

  it('rebases each sentinel time in its own format', () => {
    const now = Date.parse('2026-10-28T12:34:56.789Z');
    expect(
      rebase(
        {
          z: '2000-01-01T00:00:00Z',
          ms: '2000-01-01T00:00:00.000Z',
          offset: '2000-01-01T00:00:00+00:00',
          sqlite: '2000-01-01 00:00:00',
          http: 'Sat, 01 Jan 2000 00:00:00 GMT',
          s: 946684800,
          millis: 946684800000
        },
        now
      )
    ).toEqual({
      z: '2026-10-28T12:34:56Z',
      ms: '2026-10-28T12:34:56.789Z',
      offset: '2026-10-28T12:34:56+00:00',
      sqlite: '2026-10-28 12:34:56',
      http: 'Wed, 28 Oct 2026 12:34:56 GMT',
      s: Math.floor(now / 1000),
      millis: now
    });
  });

  describe('fixtureFetch picks one fixture per request', () => {
    const seed: Seed = {
      users: [
        { username: 'reader', password: 'pw-reader', role: 'reader' },
        { username: 'progress', password: 'pw-progress', role: 'registered' }
      ],
      library: []
    };
    const named = (name: string, fx: Fixture): Fixture =>
      Object.defineProperty(fx, 'name', { value: name, enumerable: false });
    const listing = (name: string, auth: string, status: number) =>
      named(name, {
        request: { method: 'PROPFIND', path: '/lib/', auth, headers: { depth: 'infinity' } },
        status,
        body_text: name
      });
    const URL_ = 'https://bunko.invalid/lib/';
    const propfind = (auth: string) => ({
      method: 'PROPFIND',
      headers: { Depth: 'infinity', Authorization: auth }
    });

    it('narrows same-path fixtures by the account the request signs in as', async () => {
      const { fetch } = fixtureFetch(
        [listing('as-reader', 'basic:reader', 207), listing('as-progress', 'basic:progress', 207)],
        { seed }
      );
      const progress = await fetch(URL_, propfind(basicAuthHeader('progress', 'pw-progress')));
      expect(await progress.text()).toBe('as-progress');
      const reader = await fetch(URL_, propfind(basicAuthHeader('reader', 'pw-reader')));
      expect(await reader.text()).toBe('as-reader');
    });

    it('narrows same-path fixtures by the body sent', async () => {
      const put = (name: string, body?: unknown): Fixture =>
        named(name, {
          request: { method: 'PUT', path: '/lib/f.json', auth: 'basic:reader', body },
          status: 201,
          body_text: name
        });
      const { fetch } = fixtureFetch([put('a', { v: 1 }), put('b', { v: 2 }), put('empty')], {
        seed
      });
      const auth = { Authorization: basicAuthHeader('reader', 'pw-reader') };
      const send = (body?: string) =>
        fetch('https://bunko.invalid/lib/f.json', {
          method: 'PUT',
          headers: auth,
          body
        });
      expect(await (await send('{"v":2}')).text()).toBe('b');
      expect(await (await send('{"v":1}')).text()).toBe('a');
      expect(await (await send()).text()).toBe('empty');
    });

    it('throws "ambiguous fixtures", naming them, when auth and body cannot tell', async () => {
      const { fetch } = fixtureFetch(
        [listing('first', 'basic:reader', 207), listing('second', 'basic:reader', 429)],
        { seed }
      );
      await expect(fetch(URL_, propfind(basicAuthHeader('reader', 'pw-reader')))).rejects.toThrow(
        /ambiguous fixtures.*first.*second/s
      );
    });

    it('a single match answers as before, whatever the auth', async () => {
      const { fetch } = fixtureFetch([listing('only', 'basic:progress', 207)], { seed });
      const res = await fetch(URL_, propfind(basicAuthHeader('reader', 'pw-reader')));
      expect(await res.text()).toBe('only');
    });
  });
});
