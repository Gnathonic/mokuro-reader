/**
 * A stand-in for `gapi.client` (loaded from apis.google.com in the app) that
 * speaks Drive v3 REST with `fetch` against any base, so the Drive provider can
 * run against cloudsim in tests. Imported only by tests: the real gapi
 * transport is a live-run concern.
 *
 * It answers the way gapi does: `{ result, body, status, statusText, headers }`
 * on success, and rejects with the same shape (the error JSON in `result`) on a
 * non-2xx. Parameters (`q`, `fields`, `pageToken`, `pageSize`, `orderBy`,
 * `spaces`, `addParents`, ...) are passed through unchanged; `resource` (or
 * `requestBody`) is the JSON body.
 */

type Params = Record<string, unknown>;

export interface GapiResponse<T = unknown> {
  result: T;
  body: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export function installGapiRestShim(driveApiBase: string): void {
  const base = driveApiBase.replace(/\/+$/, '');
  let token: { access_token: string } | null = null;

  async function call(
    method: string,
    path: string,
    params: Params = {},
    body?: unknown
  ): Promise<GapiResponse> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token.access_token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let result: unknown = false;
    try {
      result = text ? JSON.parse(text) : false;
    } catch {
      result = false;
    }
    const answer: GapiResponse = {
      result,
      body: text,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries())
    };
    if (!response.ok) throw answer;
    return answer;
  }

  /** Split gapi's request object into path id, JSON body and query parameters. */
  function split(p: Params = {}): { id?: string; body?: unknown; query: Params } {
    const { fileId, resource, requestBody, ...query } = p;
    return {
      id: fileId === undefined ? undefined : encodeURIComponent(String(fileId)),
      body: resource ?? requestBody,
      query
    };
  }

  const files = {
    list: (p?: Params) => call('GET', '/drive/v3/files', split(p).query),
    get: (p: Params) => {
      const { id, query } = split(p);
      return call('GET', `/drive/v3/files/${id}`, query);
    },
    create: (p: Params) => {
      const { body, query } = split(p);
      return call('POST', '/drive/v3/files', query, body ?? {});
    },
    update: (p: Params) => {
      const { id, body, query } = split(p);
      return call('PATCH', `/drive/v3/files/${id}`, query, body ?? {});
    },
    delete: (p: Params) => {
      const { id, query } = split(p);
      return call('DELETE', `/drive/v3/files/${id}`, query);
    }
  };
  const about = { get: (p?: Params) => call('GET', '/drive/v3/about', split(p).query) };

  (globalThis as Record<string, unknown>).gapi = {
    load: (_libs: string, cb: () => void) => cb(),
    client: {
      init: async () => {},
      setToken: (t: { access_token: string } | null) => {
        token = t;
      },
      getToken: () => token,
      drive: { files, about }
    },
    auth: { getToken: () => token }
  };
}

/** Take the shim off `globalThis`. */
export function removeGapiRestShim(): void {
  delete (globalThis as Record<string, unknown>).gapi;
}
