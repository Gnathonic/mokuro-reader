/**
 * Which AnkiConnect URLs this device will send cards to.
 *
 * The URL is a profile setting, and profiles arrive from outside: an imported
 * profiles file, or `profiles.json` synced from the cloud. Whatever sits at
 * that URL receives every mined sentence, the page screenshots and the cover,
 * so a profile pointing it at someone else's server would quietly ship them
 * there. A loopback URL is Anki on this machine and is used as it is. Any
 * other URL (a LAN Anki, a phone running AnkiConnect Android, or a stranger's
 * https host) stays stored in the profile but is not used until the user
 * confirms it once ON THIS DEVICE. Typing a URL into the settings field is
 * such a confirmation.
 *
 * Confirmations live in localStorage under `CONFIRMED_ANKI_URLS_KEY`, keyed by
 * the URL. They are per device by design: nothing syncs or exports that key,
 * so a profile can carry a URL to another device but never the trust in it.
 */
import { browser } from '$app/environment';
import { get, writable, type Readable } from 'svelte/store';

/** AnkiConnect's own default: Anki on this machine. */
export const DEFAULT_ANKI_CONNECT_URL = 'http://127.0.0.1:8765';

export const CONFIRMED_ANKI_URLS_KEY = 'anki_connect_confirmed_urls';

/** The loopback hosts, as `URL.hostname` spells them. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** The URL a setting means: an empty one is AnkiConnect's default. */
export function effectiveAnkiUrl(url: string | null | undefined): string {
  const trimmed = (url ?? '').trim();
  return trimmed || DEFAULT_ANKI_CONNECT_URL;
}

/**
 * The key a confirmation is stored under: the URL as the browser normalizes
 * it (case of scheme and host, default port, trailing slash), so the same
 * address typed two ways is one confirmation. Unparseable text is kept as it
 * is; it can still be confirmed, and fetch will refuse it on its own.
 */
export function ankiUrlKey(url: string | null | undefined): string {
  const effective = effectiveAnkiUrl(url);
  try {
    return new URL(effective).href;
  } catch {
    return effective;
  }
}

/** Is `url` AnkiConnect on this machine (127.0.0.1, ::1 or localhost, over http or https)? */
export function isLoopbackAnkiUrl(url: string | null | undefined): boolean {
  try {
    const parsed = new URL(effectiveAnkiUrl(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function readConfirmed(): Record<string, string> {
  if (!browser) return {};
  try {
    const raw = localStorage.getItem(CONFIRMED_ANKI_URLS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string';
      })
    );
  } catch {
    return {};
  }
}

const _confirmed = writable<Record<string, string>>(readConfirmed());

// A confirmation made in another tab (the notice sends the user to Settings,
// which may well be open elsewhere) reaches this one at once, as does storage
// cleared there (`key` null). The browser fires `storage` only in the OTHER
// tabs; this tab's own writes already set the store.
if (browser && typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== CONFIRMED_ANKI_URLS_KEY) return;
    _confirmed.set(readConfirmed());
  });
}

/** URL key → when it was confirmed on this device (ISO). Reactive, for the settings UI. */
export const confirmedAnkiUrls: Readable<Record<string, string>> = {
  subscribe: _confirmed.subscribe
};

/** May this device send to `url`? Loopback always; anything else once confirmed here. */
export function isAnkiUrlTrusted(url: string | null | undefined): boolean {
  if (isLoopbackAnkiUrl(url)) return true;
  return Object.prototype.hasOwnProperty.call(get(_confirmed), ankiUrlKey(url));
}

/** The user confirmed `url` on this device: send to it from now on. */
export function confirmAnkiUrl(url: string | null | undefined): void {
  if (isLoopbackAnkiUrl(url)) return;
  const key = ankiUrlKey(url);
  const next = { ...readConfirmed(), ...get(_confirmed), [key]: new Date().toISOString() };
  _confirmed.set(next);
  if (!browser) return;
  try {
    localStorage.setItem(CONFIRMED_ANKI_URLS_KEY, JSON.stringify(next));
  } catch (error) {
    // Still trusted for this session; the next one asks again.
    console.warn('[anki-connect] could not remember the confirmed URL:', error);
  }
}

/** What the user is told when an unconfirmed URL is about to be used. */
export function unconfirmedAnkiUrlMessage(url: string | null | undefined): string {
  return `AnkiConnect URL ${effectiveAnkiUrl(url)} is not confirmed on this device. Confirm it in Settings → Anki Connect before cards are sent there.`;
}

/**
 * The notice to show instead of sending to `url`, or null when this device
 * may send to it. The client's guard answers an unconfirmed URL with this
 * notice and no result, and the snackbar holds one message: a flow that would
 * read "no result" as a failure of its own ("no recent card") and report it
 * checks this first and stops on the notice, or the user never sees it.
 */
export function ankiUrlRefusal(url: string | null | undefined): string | null {
  return isAnkiUrlTrusted(url) ? null : unconfirmedAnkiUrlMessage(url);
}

/** Test-only: re-read the confirmations from storage (after a test cleared it). */
export function resetAnkiUrlTrustForTest(): void {
  _confirmed.set(readConfirmed());
}
