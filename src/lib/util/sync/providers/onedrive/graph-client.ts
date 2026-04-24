import { ONEDRIVE_CONFIG } from './constants';

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
  throw new Error(`Graph ${response.status} ${response.statusText}: ${text || '(no body)'}`);
}

export async function getDriveQuota(accessToken: string): Promise<DriveQuota> {
  const response = await fetch(`${BASE}/me/drive`, { headers: authHeaders(accessToken) });
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { quota?: DriveQuota };
  return data.quota ?? { used: 0, total: 0, remaining: 0 };
}

export async function listChildren(accessToken: string, path: string): Promise<DriveItem[]> {
  const url = path
    ? `${BASE}/me/drive/root:/${encodePath(path)}:/children`
    : `${BASE}/me/drive/root/children`;
  const response = await fetch(url, { headers: authHeaders(accessToken) });
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { value: DriveItem[] };
  return data.value;
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
