import type { BeforeSendEvent } from '@vercel/analytics';

/**
 * Query parameters a sign-in can leave in a page URL: OAuth codes and state
 * (the Drive sign-in's callback), tokens (an implicit grant's redirect).
 */
const SECRET_PARAMS = ['code', 'state', 'access_token', 'id_token', 'refresh_token', 'token'];

/**
 * The URL Vercel Analytics may report for a page view: without sign-in
 * secrets in its query, and without a fragment unless it is an app route
 * (`#/…`). AniList's implicit grant lands on `/#access_token=…`; that
 * fragment is a token, never a route.
 */
export function scrubAnalyticsUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.split(/[?#]/)[0];
  }
  for (const name of SECRET_PARAMS) parsed.searchParams.delete(name);
  if (parsed.hash && !parsed.hash.startsWith('#/')) parsed.hash = '';
  // The route's own query (`#/reader/x?…`) is the app's; drop secrets there too.
  const hashQuery = parsed.hash.indexOf('?');
  if (hashQuery !== -1) {
    const params = new URLSearchParams(parsed.hash.slice(hashQuery + 1));
    for (const name of SECRET_PARAMS) params.delete(name);
    const rest = params.toString();
    parsed.hash = parsed.hash.slice(0, hashQuery) + (rest ? `?${rest}` : '');
  }
  return parsed.toString();
}

/** `inject({ beforeSend })`: every event, with its URL scrubbed. */
export function scrubAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent {
  return { ...event, url: scrubAnalyticsUrl(event.url) };
}
