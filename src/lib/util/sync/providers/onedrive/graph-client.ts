import { ONEDRIVE_CONFIG } from './constants';
import { ProviderError } from '../../provider-interface';
import { onedriveTokenManager } from './token-manager';

const BASE = ONEDRIVE_CONFIG.GRAPH_BASE_URL;

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
  parentReference?: { id?: string; path?: string };
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

async function parseError(response: Response): Promise<never> {
  const text = await response.text().catch(() => '');
  if (response.status === 401) {
    // Token rejected server-side (revocation, password change). Silent
    // refresh alone won't detect this — flag the session for reconnect.
    onedriveTokenManager.markNeedsAttention();
  }
  throw new ProviderError(
    `Graph ${response.status} ${response.statusText}: ${text || '(no body)'}`,
    'onedrive',
    `GRAPH_${response.status}`,
    response.status === 401,
    response.status === 429 || response.status >= 500
  );
}

export async function getDriveQuota(accessToken: string): Promise<DriveQuota> {
  const response = await fetch(`${BASE}/me/drive`, { headers: authHeaders(accessToken) });
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { quota?: DriveQuota };
  return data.quota ?? { used: 0, total: 0, remaining: 0 };
}

export async function listChildren(accessToken: string, path: string): Promise<DriveItem[]> {
  // Graph pages children (default ~200 per response); follow @odata.nextLink so
  // large folders (a library with hundreds of series, or a series with many
  // files) are not silently truncated.
  let url: string = path
    ? `${BASE}/me/drive/root:/${encodePath(path)}:/children`
    : `${BASE}/me/drive/root/children`;
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
  const url = path ? `${BASE}/me/drive/root:/${encodePath(path)}` : `${BASE}/me/drive/root`;
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
    ? `${BASE}/me/drive/root:/${encodePath(parentPath)}:/children`
    : `${BASE}/me/drive/root/children`;
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
  const response = await fetch(`${BASE}/me/drive/items/${encodeURIComponent(itemId)}`, {
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
  const response = await fetch(`${BASE}/me/drive/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as DriveItem;
}

export async function createUploadSession(accessToken: string, path: string): Promise<string> {
  const response = await fetch(`${BASE}/me/drive/root:/${encodePath(path)}:/createUploadSession`, {
    method: 'POST',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'replace' }
    })
  });
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { uploadUrl: string };
  return data.uploadUrl;
}
