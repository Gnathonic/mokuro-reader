/**
 * The contract helper's own rules: a Bunko checkout named by `BUNKO_REPO` must be
 * there and hold the baseline, one found by looking around must hold the contract the tests read, records are only ever written into one named that way, and Bunko's time
 * sentinels rebase in the format they were written in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CONTRACT_BASELINE,
  contractDir,
  findSiblingContract,
  rebase,
  recordRequest
} from './contract';

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
    const root = mkdtempSync(join(tmpdir(), 'contract-baseline-'));
    try {
      const dir = join(root, 'interop', 'contract');
      mkdirSync(join(dir, 'bunko'), { recursive: true });
      writeFileSync(join(dir, 'seed.json'), '{}');
      writeFileSync(join(dir, 'sidecar-names.json'), '{}');
      writeFileSync(join(dir, 'bunko', 'history-put.json'), '{}');
      vi.stubEnv('BUNKO_REPO', root);
      const missing = CONTRACT_BASELINE.filter(
        (rel) => rel !== 'sidecar-names.json' && rel !== 'bunko/history-put.json'
      );
      let message = '';
      try {
        contractDir();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(`BUNKO_REPO=${root}`);
      for (const rel of missing) expect(message).toContain(rel);
      expect(message).not.toContain('sidecar-names.json');
      expect(message).not.toContain('history-put.json');

      // Complete it, and the same checkout is the contract.
      mkdirSync(join(dir, 'seal'));
      for (const rel of missing.filter((r) => r !== 'seal')) writeFileSync(join(dir, rel), '{}');
      expect(contractDir()).toBe(dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
});
