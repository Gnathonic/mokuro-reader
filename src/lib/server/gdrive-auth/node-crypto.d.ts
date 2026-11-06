/**
 * The few `node:crypto` APIs the Drive auth backend calls, typed.
 *
 * The project carries no `@types/node`: it is a browser app, and those types
 * would retype browser globals (`setTimeout` returning a `Timeout`, …) across
 * every client module. This declares exactly the subset the server code in
 * this folder uses, with the argument values it passes. Delete this file if
 * `@types/node` is ever added: its own declarations supersede these.
 */
declare module 'node:crypto' {
  export interface CipherGCM {
    setAAD(data: Uint8Array): this;
    update(data: Uint8Array): Uint8Array;
    final(): Uint8Array;
    getAuthTag(): Uint8Array;
  }

  export interface DecipherGCM {
    setAAD(data: Uint8Array): this;
    setAuthTag(tag: Uint8Array): this;
    update(data: Uint8Array): Uint8Array;
    final(): Uint8Array;
  }

  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(): Uint8Array;
  }

  export interface KeyObject {
    readonly type: 'public' | 'private' | 'secret';
    readonly asymmetricKeyType?: string;
  }

  export function createCipheriv(
    algorithm: 'aes-256-gcm',
    key: Uint8Array,
    iv: Uint8Array,
    options: { authTagLength: 16 }
  ): CipherGCM;

  export function createDecipheriv(
    algorithm: 'aes-256-gcm',
    key: Uint8Array,
    iv: Uint8Array,
    options: { authTagLength: 16 }
  ): DecipherGCM;

  export function createHash(algorithm: 'sha256'): Hash;

  export function randomBytes(size: number): Uint8Array;

  export function createPublicKey(key: { key: JsonWebKey; format: 'jwk' }): KeyObject;

  export function verify(
    algorithm: 'sha256',
    data: Uint8Array,
    key: { key: KeyObject; dsaEncoding: 'ieee-p1363' },
    signature: Uint8Array
  ): boolean;
}
