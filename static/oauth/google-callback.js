/**
 * Google's redirect target for the Drive sign-in (`google-callback.html`,
 * redirect_uri = origin + `/oauth/google-callback.html`). A static file served
 * by the CDN, so the `?code=` in its URL never reaches a function's logs.
 *
 * It only hands the answer to the app: the code, the state and any error go
 * into sessionStorage (`gdrive_oauth_callback`), and the page replaces itself
 * with the app at the hash the sign-in started from. The app checks the state
 * against the flow it started and redeems the code (`auth-backend.ts`). A
 * classic script in <head>, so it runs before anything else on the page.
 */
(function () {
  'use strict';

  var query = location.search;
  // Before anything else can read or report the URL: drop the code from the
  // address bar and from this history entry.
  history.replaceState(null, '', location.pathname);

  var PENDING_KEY = 'gdrive_oauth_pending';
  var CALLBACK_KEY = 'gdrive_oauth_callback';
  // A hash route of the app (`#/cloud`, `#/series/<uuid>`), nothing else: no
  // path, no scheme, nothing that could make the next URL leave this origin.
  var RETURN_TO = /^#\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]{0,500}$/;

  /** A query value we pass on: a bounded printable string, else null. */
  function clip(value, pattern) {
    return typeof value === 'string' && value.length <= 2048 && pattern.test(value) ? value : null;
  }

  var params = new URLSearchParams(query);
  var answer = {
    code: clip(params.get('code'), /^[\x21-\x7e]+$/),
    state: clip(params.get('state'), /^[A-Za-z0-9_-]+$/),
    error: clip(params.get('error'), /^[a-z_]+$/)
  };

  var returnTo = '';
  try {
    var store = sessionStorage;
    var pending = JSON.parse(store.getItem(PENDING_KEY) || 'null');
    if (pending && typeof pending === 'object') {
      if (typeof pending.returnTo === 'string' && RETURN_TO.test(pending.returnTo)) {
        returnTo = pending.returnTo;
      }
      // Only a sign-in this tab started gets an answer to read; a code that
      // arrives with no pending flow (a crafted link) is dropped here.
      if (answer.code || answer.error) store.setItem(CALLBACK_KEY, JSON.stringify(answer));
    }
  } catch {
    // Storage blocked: the app finds no answer and stays signed out.
  }

  location.replace('/' + returnTo);
})();
