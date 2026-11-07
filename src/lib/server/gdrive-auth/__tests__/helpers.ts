/**
 * Fakes for the auth backend's tests: throwaway keys, a request event with a
 * cookie jar, a scripted Google, and a WebCrypto device key that signs proofs
 * the way the browser does. Nothing here is a real secret.
 */
import { vi } from 'vitest';
import type { AuthEvent } from '../http';
import type { FetchLike } from '../google';
import type { AuthEnv } from '../config';
import { popMessage, type PopProof } from '../pop';

export const ORIGIN = 'https://reader.example';

/** A fresh random 32-byte key, base64 — what `openssl rand -base64 32` prints. */
export function throwawayKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

export function testEnv(overrides: AuthEnv = {}): AuthEnv {
  return {
    GDRIVE_CLIENT_ID: 'test-client.apps.example',
    GDRIVE_CLIENT_SECRET: 'test-secret-not-real',
    GDRIVE_SESSION_KEY: throwawayKey(),
    ...overrides
  };
}

export interface CookieWrite {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** The handlers' view of SvelteKit's cookies, recording every write. */
export class CookieJar {
  values = new Map<string, string>();
  sets: CookieWrite[] = [];
  deletes: { name: string; options: Record<string, unknown> }[] = [];

  get = (name: string): string | undefined => this.values.get(name);
  set = (name: string, value: string, options: Record<string, unknown>): void => {
    this.values.set(name, value);
    this.sets.push({ name, value, options });
  };
  delete = (name: string, options: Record<string, unknown>): void => {
    this.values.delete(name);
    this.deletes.push({ name, options });
  };
}

export interface EventOptions {
  origin?: string;
  path?: string;
  method?: string;
  body?: unknown;
  rawBody?: BodyInit | null;
  headers?: Record<string, string | null>;
  jar?: CookieJar;
}

/** A same-origin JSON POST, as the client sends it; `headers` overrides (null drops one). */
export function authEvent(options: EventOptions = {}): AuthEvent & { jar: CookieJar } {
  const origin = options.origin ?? ORIGIN;
  const url = new URL(options.path ?? '/api/gdrive/refresh', origin);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin,
    'sec-fetch-site': 'same-origin',
    'x-requested-with': 'XMLHttpRequest'
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[name.toLowerCase()];
    else headers[name.toLowerCase()] = value;
  }
  const method = options.method ?? 'POST';
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : method === 'GET' || method === 'HEAD'
        ? null
        : JSON.stringify(options.body ?? {});
  const request = new Request(url, {
    method,
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {})
  } as RequestInit);
  const jar = options.jar ?? new CookieJar();
  return { request, url, cookies: jar as unknown as AuthEvent['cookies'], jar };
}

export interface GoogleCall {
  url: string;
  form: Record<string, string>;
  init: RequestInit;
}

export type GoogleAnswer = { status: number; body?: unknown; text?: string } | 'network';

/** A scripted Google: `answer` decides each reply; every call is recorded. */
export function fakeGoogle(answer: (call: GoogleCall) => GoogleAnswer) {
  const calls: GoogleCall[] = [];
  const fetch: FetchLike = vi.fn(async (url: string, init: RequestInit) => {
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    const call = { url, form, init };
    calls.push(call);
    const reply = answer(call);
    if (reply === 'network') throw new TypeError('fetch failed');
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(text, {
      status: reply.status,
      headers: { 'content-type': reply.text ? 'text/html' : 'application/json' }
    });
  });
  return { fetch, calls };
}

/** Google's answer to a code or refresh-token grant. */
export function tokenAnswer(extra: Record<string, unknown> = {}): GoogleAnswer {
  return {
    status: 200,
    body: {
      access_token: 'ya29.test-access',
      expires_in: 3599,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/drive.file',
      ...extra
    }
  };
}

/** A device key as the browser makes it: non-extractable private half, WebCrypto. */
export async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify'
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! };
  return {
    pair,
    jwk: publicJwk,
    /** A proof for `path` at `origin`, signed at `ts`. */
    async prove(path: string, ts: number, origin = ORIGIN): Promise<PopProof> {
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(popMessage(origin, path, ts))
      );
      const bytes = new Uint8Array(signature);
      const sig = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      return { jwk: publicJwk, ts, sig };
    }
  };
}

export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
