import { graphBase } from './constants';
import { ProviderError } from '../../provider-interface';
import { onedriveTokenManager } from './token-manager';
import { graphErrorCode, isGraphQuotaFailure } from './graph-errors';

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  /** Changes with the CONTENT only (an eTag also moves on a rename or a property change). */
  cTag?: string;
  folder?: { childCount?: number } & Record<string, unknown>;
  file?: Record<string, unknown>;
  parentReference?: { id?: string; path?: string };
  /** Delta only: the item is gone (personal accounts send no name with it). */
  deleted?: { state?: string };
  /** The drive's own root folder. */
  root?: Record<string, unknown>;
}

export interface DriveQuota {
  used: number;
  total: number;
  remaining: number;
}

function authHeaders(accessToken: string, extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${accessToken}`, ...(extra ?? {}) };
}

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function parseError(response: Response, body?: string): Promise<never> {
  const text = body ?? (await response.text().catch(() => ''));
  if (response.status === 401) {
    // Token rejected server-side (revocation, password change). Silent
    // refresh alone won't detect this — flag the session for reconnect.
    onedriveTokenManager.markNeedsAttention();
  }
  // A full drive (507 or a quota code) is not a 5xx to retry.
  const quota = isGraphQuotaFailure(response.status, graphErrorCode(text));
  throw new ProviderError(
    `Graph ${response.status} ${response.statusText}: ${text || '(no body)'}`,
    'onedrive',
    quota ? 'QUOTA_EXCEEDED' : `GRAPH_${response.status}`,
    response.status === 401,
    !quota && (response.status === 429 || response.status >= 500)
  );
}

export async function getDriveQuota(accessToken: string): Promise<DriveQuota> {
  const response = await fetch(`${graphBase()}/me/drive`, { headers: authHeaders(accessToken) });
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { quota?: DriveQuota };
  return data.quota ?? { used: 0, total: 0, remaining: 0 };
}

export async function listChildren(accessToken: string, path: string): Promise<DriveItem[]> {
  // Graph pages children (default ~200 per response); follow @odata.nextLink so
  // large folders (a library with hundreds of series, or a series with many
  // files) are not silently truncated.
  let url: string = path
    ? `${graphBase()}/me/drive/root:/${encodePath(path)}:/children`
    : `${graphBase()}/me/drive/root/children`;
  const items: DriveItem[] = [];
  while (url) {
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    if (!response.ok) await parseError(response);
    const data = (await response.json()) as { value: DriveItem[]; '@odata.nextLink'?: string };
    items.push(...data.value);
    url = data['@odata.nextLink'] ?? '';
  }
  return items;
}

export async function getItemByPath(accessToken: string, path: string): Promise<DriveItem | null> {
  const url = path
    ? `${graphBase()}/me/drive/root:/${encodePath(path)}`
    : `${graphBase()}/me/drive/root`;
  const response = await fetch(url, { headers: authHeaders(accessToken) });
  if (response.status === 404) return null;
  if (!response.ok) await parseError(response);
  return (await response.json()) as DriveItem;
}

/** Download an item's content (`/content` redirects to a pre-authenticated URL). */
export async function downloadItemContent(accessToken: string, itemId: string): Promise<Blob> {
  const response = await fetch(
    `${graphBase()}/me/drive/items/${encodeURIComponent(itemId)}/content`,
    {
      headers: authHeaders(accessToken)
    }
  );
  if (!response.ok) await parseError(response);
  return await response.blob();
}

/**
 * One item's stamp fields by id (`$select`ed: a few hundred bytes), or null
 * when it is gone (404).
 */
export async function getItemStamp(accessToken: string, id: string): Promise<DriveItem | null> {
  const url = `${graphBase()}/me/drive/items/${encodeURIComponent(id)}?$select=id,name,size,lastModifiedDateTime,eTag,cTag,file`;
  const response = await fetch(url, { headers: authHeaders(accessToken) });
  if (response.status === 404) return null;
  if (!response.ok) await parseError(response);
  return (await response.json()) as DriveItem;
}

export async function createFolder(
  accessToken: string,
  parentPath: string,
  name: string
): Promise<DriveItem> {
  const url = parentPath
    ? `${graphBase()}/me/drive/root:/${encodePath(parentPath)}:/children`
    : `${graphBase()}/me/drive/root/children`;
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail'
    })
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as DriveItem;
}

export async function deleteItem(accessToken: string, itemId: string): Promise<void> {
  const response = await fetch(`${graphBase()}/me/drive/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken)
  });
  if (response.status === 404) return;
  if (!response.ok && response.status !== 204) await parseError(response);
}

export interface PatchItemBody {
  name?: string;
  parentReference?: { id: string };
}

export async function patchItem(
  accessToken: string,
  itemId: string,
  body: PatchItemBody
): Promise<DriveItem> {
  const response = await fetch(`${graphBase()}/me/drive/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as DriveItem;
}

export async function createUploadSession(accessToken: string, path: string): Promise<string> {
  const response = await fetch(
    `${graphBase()}/me/drive/root:/${encodePath(path)}:/createUploadSession`,
    {
      method: 'POST',
      headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'replace' }
      })
    }
  );
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { uploadUrl: string };
  return data.uploadUrl;
}

/** What a delta read asks for per item: what the listing and the folder map need. */
const DELTA_SELECT =
  'id,name,size,lastModifiedDateTime,eTag,cTag,file,folder,deleted,parentReference,root';

/** A delta read's answer: the changes and where the next read resumes. */
export interface DeltaBatch {
  items: DriveItem[];
  deltaLink: string;
}

/**
 * Is a link Graph handed back one this client may send its token to? Delta
 * and next links are followed verbatim, bearer token and all, so anything
 * that is not this Graph's own address is refused (Bunko's `own_link`).
 */
function isOwnGraphLink(link: string): boolean {
  return link.startsWith(`${graphBase()}/`);
}

/**
 * The change feed's current head: `root/delta?token=latest` returns no items,
 * only the deltaLink a later {@link readDelta} resumes from. Root-scoped on
 * purpose — work and school drives serve delta on the drive root only, and
 * the reader asks for `Files.ReadWrite` over the whole drive anyway — so the
 * feed carries every change in the drive and the cache keeps the ones under
 * the mokuro folder (by folder id, never `parentReference.path`).
 */
export async function startDelta(accessToken: string): Promise<string> {
  const response = await fetch(
    `${graphBase()}/me/drive/root/delta?token=latest&$select=${DELTA_SELECT}`,
    { headers: authHeaders(accessToken) }
  );
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { '@odata.deltaLink'?: string };
  const link = data['@odata.deltaLink'];
  if (!link || !isOwnGraphLink(link)) {
    throw new ProviderError(
      'Graph delta?token=latest returned no usable deltaLink',
      'onedrive',
      'GRAPH_DELTA_LINK'
    );
  }
  return link;
}

/**
 * Every change since `deltaLink`, following `@odata.nextLink` to the next
 * deltaLink. `'resync'` when Graph no longer knows the position (410 Gone /
 * `resyncRequired`: the caller lists in full); `'too-long'` past `maxPages`
 * pages, where reading on would cost more than the listing it saves. Items
 * may repeat (the last one wins) and come in no promised order. Any other
 * refusal throws as every Graph call does (`parseError`).
 */
export async function readDelta(
  accessToken: string,
  deltaLink: string,
  maxPages: number
): Promise<DeltaBatch | 'resync' | 'too-long'> {
  const items: DriveItem[] = [];
  let url = deltaLink;
  for (let page = 0; ; page++) {
    if (page >= maxPages) return 'too-long';
    if (!isOwnGraphLink(url)) return 'resync';
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    if (response.status === 410) {
      await response.text().catch(() => '');
      return 'resync';
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (/resyncRequired/i.test(graphErrorCode(text) ?? '')) return 'resync';
      await parseError(response, text);
    }
    const data = (await response.json()) as {
      value?: DriveItem[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    items.push(...(data.value ?? []));
    if (data['@odata.deltaLink']) return { items, deltaLink: data['@odata.deltaLink'] };
    if (!data['@odata.nextLink']) {
      throw new ProviderError(
        'Graph delta page carried neither a nextLink nor a deltaLink',
        'onedrive',
        'GRAPH_DELTA_LINK'
      );
    }
    url = data['@odata.nextLink'];
  }
}
