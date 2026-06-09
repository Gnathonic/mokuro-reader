/**
 * Ask the browser to mark our storage as persistent so IndexedDB isn't evicted.
 *
 * Firefox shows a permission prompt for this (Chromium decides silently), and
 * both MDN and web.dev are explicit that the request should be made from a user
 * gesture at the moment important data is saved — NOT on page load. Call this
 * synchronously from the gesture that starts an import so the prompt actually
 * appears; calling it deep in async work or at startup means Firefox won't.
 *
 * @returns true if storage is now persistent, false otherwise (incl. unsupported)
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage?.persist) {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

export function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}
