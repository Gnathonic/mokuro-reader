/**
 * Test helper: a client for cloudsim's control API (`{base}/_sim/`), the cloud
 * simulator Bunko builds (`bunko-cloudsim`). The suites under
 * `src/lib/interop/cloudsim/` run when `CLOUDSIM_URL` names a running one and
 * skip otherwise. Imported only by tests.
 */

export type SimProvider = 'google' | 'microsoft' | 'mega';

export interface SimTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface SimFile {
  path: string;
  size: number;
  sha256: string;
}

export interface SimLogEntry {
  seq: number;
  provider: SimProvider;
  account: string;
  method: string;
  path: string;
  class: string;
  units: number;
  bytes_in: number;
  bytes_out: number;
  status: number;
}

export interface SimFault {
  provider: SimProvider;
  account?: string;
  method?: string;
  path_has: string;
  status: number;
  reason: string;
  retry_after?: number;
  times?: number;
}

/** The simulator's base URL from `CLOUDSIM_URL`, or null when none is running. */
export function cloudsimUrl(): string | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const url = env?.CLOUDSIM_URL?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

function base(): string {
  const url = cloudsimUrl();
  if (!url) throw new Error('CLOUDSIM_URL is not set');
  return url;
}

function b64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
  return btoa(s);
}

async function control<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base()}/_sim/${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`cloudsim ${method} ${path}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export const sim = {
  /** The provider prefixes on this simulator. */
  bases() {
    const b = base();
    return {
      driveApi: `${b}/google`,
      driveUpload: `${b}/google/upload`,
      graph: `${b}/graph/v1.0`,
      megaGateway: `${b}/mega/`
    };
  },
  token: (provider: SimProvider, account = 'default') =>
    control<SimTokens>('POST', 'token', { provider, account }),
  revoke: (token: string) => control<{ ok: boolean }>('POST', 'token/revoke', { token }),
  expire: (token: string) => control<{ ok: boolean }>('POST', 'token/expire', { token }),
  megaAccount: (account: string, email: string, password: string) =>
    control<{ ok: boolean }>('POST', 'mega/account', { account, email, password }),
  seed: (
    provider: SimProvider,
    files: Array<{ path: string; data: Uint8Array | string }>,
    account = 'default'
  ) =>
    control<{ seeded: number }>('POST', 'seed', {
      provider,
      account,
      files: files.map((f) => ({
        path: f.path,
        content_base64: b64(typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data)
      }))
    }),
  files: (provider: SimProvider, account = 'default') =>
    control<SimFile[]>('GET', `files?provider=${provider}&account=${encodeURIComponent(account)}`),
  fault: (fault: SimFault) => control<{ ok: boolean }>('POST', 'fault', fault),
  knobs: (provider: SimProvider, knobs: Record<string, unknown>, account = 'default') =>
    control<{ ok: boolean }>('POST', 'knobs', { provider, account, ...knobs }),
  log: () => control<SimLogEntry[]>('GET', 'log'),
  clearLog: () => control<null>('DELETE', 'log'),
  violations: () => control<string[]>('GET', 'violations'),
  /** The violations so far, cleared (so one test's mistake does not fail the next). */
  async takeViolations(): Promise<string[]> {
    const v = await control<string[]>('GET', 'violations');
    await control<null>('DELETE', 'violations');
    return v;
  },
  reset: () => control<null>('POST', 'reset', {})
};

/** Hex SHA-256 of bytes (to compare with `sim.files`). */
export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** A Blob's text, whichever Blob implementation made it (jsdom's has no `text()`). */
export function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/**
 * Let jsdom's XMLHttpRequest send the Blobs tests make. `src/test-setup.ts`
 * swaps in Node's Blob (so fake-indexeddb round-trips Files), which jsdom's XHR
 * does not recognise and would send as the string "[object Blob]". A browser
 * sends a Blob's bytes; this does the same by reading it first. Returns the
 * undo.
 */
export function sendBlobsAsBytes(): () => void {
  const proto = XMLHttpRequest.prototype;
  const send = proto.send;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (body instanceof Blob) {
      body.arrayBuffer().then(
        (buf) => send.call(this, new Uint8Array(buf)),
        () => send.call(this, body)
      );
      return;
    }
    send.call(this, body);
  };
  return () => {
    proto.send = send;
  };
}

/**
 * Let Node's `fetch` take the abort signals the providers pass. Under jsdom,
 * `AbortSignal` (and `AbortSignal.timeout`) is jsdom's, which Node's fetch
 * refuses with a TypeError; a browser's fetch takes its own. The signals only
 * bound a request's time, so the wrapper drops them (an already-aborted one
 * still rejects). Returns the undo.
 */
export function fetchWithoutForeignSignals(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) {
      if (init.signal.aborted) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }
      const { signal: _signal, ...rest } = init;
      return original(input, rest);
    }
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
