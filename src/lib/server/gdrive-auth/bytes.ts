/** Byte helpers for the auth backend, on Uint8Array (no Buffer: see node-crypto.d.ts). */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode unpadded base64url, or null. Strict: only the base64url alphabet, and
 * only the CANONICAL spelling of its bytes (no stray trailing bits), so one
 * byte string has exactly one accepted encoding.
 */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  return toBase64Url(bytes) === text ? bytes : null;
}

/** Decode standard base64 (padding optional, surrounding whitespace ignored), or null. */
export function fromBase64(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return null;
  try {
    return Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
