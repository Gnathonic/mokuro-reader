import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '$lib/util/sync/provider-interface';
import { positionsReadAllowed, positionsWriteAllowed } from './positions-capability';

const base: ProviderStatus = {
  isAuthenticated: true,
  hasStoredCredentials: true,
  needsAttention: false,
  statusMessage: ''
};

describe('positions capability', () => {
  it('plain storage reads and writes', () => {
    expect(positionsReadAllowed({ ...base })).toBe(true);
    expect(positionsWriteAllowed({ ...base })).toBe(true);
  });

  it('bunko that does not list positions.json: neither', () => {
    expect(positionsReadAllowed({ ...base, serverCompilesMetadata: true })).toBe(false);
    expect(
      positionsReadAllowed({ ...base, serverCompilesMetadata: true, positionsSync: false })
    ).toBe(false);
    expect(positionsWriteAllowed({ ...base, serverCompilesMetadata: true })).toBe(false);
  });

  it('bunko that lists it: both', () => {
    const status = { ...base, serverCompilesMetadata: true, positionsSync: true };
    expect(positionsReadAllowed(status)).toBe(true);
    expect(positionsWriteAllowed(status)).toBe(true);
  });

  it('read-only: reads, never writes', () => {
    expect(positionsReadAllowed({ ...base, isReadOnly: true })).toBe(true);
    expect(positionsWriteAllowed({ ...base, isReadOnly: true })).toBe(false);
  });
});
