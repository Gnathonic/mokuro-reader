import { describe, expect, it } from 'vitest';
import {
  isMokuroCloudAttestation,
  isMokuroSha256,
  isUntouchedUpdatedOcr,
  sha256Hex
} from './mokuro-hash';

describe('sha256Hex', () => {
  // FIPS 180-2 test vector: SHA-256("abc").
  const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

  it('hashes a Blob, an ArrayBuffer and a Uint8Array to the same lowercase hex', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(new Blob([bytes]))).toBe(ABC);
    expect(await sha256Hex(bytes)).toBe(ABC);
    expect(await sha256Hex(bytes.buffer.slice(0) as ArrayBuffer)).toBe(ABC);
  });

  it('hashes the JSON bytes exactly — no normalisation of whitespace or key order', async () => {
    const a = await sha256Hex(new Blob(['{"a":1,"b":2}']));
    const b = await sha256Hex(new Blob(['{"b":2,"a":1}']));
    const c = await sha256Hex(new Blob(['{"a": 1,"b":2}']));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('isMokuroSha256', () => {
  it('accepts exactly 64 lowercase hex digits', () => {
    expect(isMokuroSha256('a'.repeat(64))).toBe(true);
    expect(isMokuroSha256('A'.repeat(64))).toBe(false);
    expect(isMokuroSha256('a'.repeat(63))).toBe(false);
    expect(isMokuroSha256('g'.repeat(64))).toBe(false);
    expect(isMokuroSha256(undefined)).toBe(false);
    expect(isMokuroSha256(42)).toBe(false);
  });
});

describe('isMokuroCloudAttestation', () => {
  it('wants a provider and a positive whole size; the mtime is optional', () => {
    expect(isMokuroCloudAttestation({ provider: 'webdav', size: 10 })).toBe(true);
    expect(isMokuroCloudAttestation({ provider: 'webdav', size: 10, modified: 5 })).toBe(true);
    expect(isMokuroCloudAttestation({ provider: 'webdav', size: 0 })).toBe(false);
    expect(isMokuroCloudAttestation({ size: 10 })).toBe(false);
    expect(isMokuroCloudAttestation({ provider: 'webdav', size: 10, modified: -1 })).toBe(false);
    expect(isMokuroCloudAttestation(undefined)).toBe(false);
  });
});

describe('isUntouchedUpdatedOcr', () => {
  it('holds while source_at equals updated_at, and dies with the first edit', () => {
    const row = { source_sha256: 'a'.repeat(64), source_at: 't1', updated_at: 't1' };
    expect(isUntouchedUpdatedOcr(row)).toBe(true);
    expect(isUntouchedUpdatedOcr({ ...row, updated_at: 't2' })).toBe(false);
    expect(isUntouchedUpdatedOcr({ updated_at: 't1' })).toBe(false);
    expect(isUntouchedUpdatedOcr(undefined)).toBe(false);
  });
});
