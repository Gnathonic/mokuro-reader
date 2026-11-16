import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteSidecarRule, resetNotedSidecarRules, SIDECAR_RULE } from './sidecar-rule';
import { SIDECAR_RULE as FROM_SYNCABLE } from './syncable-file';
import vendored from '#lib/interop/contract/sidecar-names.json';
import { fetchServerIdentity } from './providers/webdav/identity';
import { parseBunkoMarker } from '#lib/catalog/cloud-bunko-marker.js';

afterEach(() => {
  resetNotedSidecarRules();
  vi.restoreAllMocks();
});

describe('sidecar_rule (informational, never a gate)', () => {
  it('is the vendored contract’s rule', () => {
    expect(SIDECAR_RULE).toBe(2);
    expect(FROM_SYNCABLE).toBe(SIDECAR_RULE);
    expect((vendored as { rule: number }).rule).toBe(SIDECAR_RULE);
  });

  it('logs once per source when the server’s rule is newer, and never for ours or none', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(noteSidecarRule('marker', 2)).toBe(2);
    expect(noteSidecarRule('marker', undefined)).toBeUndefined();
    expect(noteSidecarRule('marker', '3')).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
    expect(noteSidecarRule('marker', 3)).toBe(3);
    noteSidecarRule('marker', 3);
    expect(info).toHaveBeenCalledTimes(1);
    noteSidecarRule('login-me', 3);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('a newer rule in /login/api/me or the marker changes nothing the reader decides', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const me = {
      authenticated: true,
      username: 'u',
      role: 'registered',
      permissions: { canWriteProgress: true, canAddFiles: true, canModifyDelete: false }
    };
    const answer = (body: unknown) =>
      fetchServerIdentity(
        'https://host',
        'u',
        'p',
        (async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })) as unknown as typeof fetch
      );
    expect(await answer({ ...me, sidecar_rule: 9 })).toEqual(await answer(me));
    const marker = { version: 1, kind: 'mokuro-bunko', instance_id: 'i' };
    expect(parseBunkoMarker({ ...marker, sidecar_rule: 9 })).toEqual(parseBunkoMarker(marker));
  });
});
