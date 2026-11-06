# Google Drive auth backend

With `VITE_GDRIVE_AUTH_BACKEND=true` in the build, Google Drive signs in **once**
with the authorization-code flow (PKCE, full-page redirect, `prompt=consent`).
After that it renews access tokens silently, with no hourly account-chooser
popup. Google's refresh token never reaches page script. It lives AES-GCM-sealed
in an `HttpOnly`, `SameSite=Strict` cookie that only the app's own
`/api/gdrive/*` routes read. There is no database: the cookie **is** the session.

Without the flag, the implicit Google Identity Services flow runs exactly as
before. The flag-less build is also what self-hosts, previews without secrets
and the e2e suite use.

| Piece             | Where                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes            | `src/routes/api/gdrive/{session,refresh,logout}/+server.ts`                                                                                                                                                                   |
| Server logic      | `src/lib/server/gdrive-auth/` (server-only)                                                                                                                                                                                   |
| Callback page     | `static/oauth/google-callback.{html,js}`                                                                                                                                                                                      |
| Client            | `src/lib/util/sync/providers/google-drive/{auth-backend,device-key,token-manager}.ts`                                                                                                                                         |
| Headers           | `vercel.json` (`/oauth/(.*)`, `/api/(.*)`)                                                                                                                                                                                    |
| Service worker    | `src/service-worker.js` never touches `/api/` or `/oauth/`; a worker from an older build, still in control until the update banner is accepted, may cache the callback URL, so `takeCallback` purges cached `/oauth/` entries |
| Real-browser test | `e2e/gdrive-auth-backend.spec.ts`                                                                                                                                                                                             |

## Configuration

| Variable                   | Read by                | Type   | Value                                                                     |
| -------------------------- | ---------------------- | ------ | ------------------------------------------------------------------------- |
| `VITE_GDRIVE_AUTH_BACKEND` | the client build       | plain  | `true` turns backend mode on. Set it only where the secrets below are set |
| `GDRIVE_CLIENT_SECRET`     | the server, at runtime | secret | The Google client's secret                                                |
| `GDRIVE_SESSION_KEY`       | the server, at runtime | secret | `openssl rand -base64 32` (must decode to exactly 32 bytes)               |
| `GDRIVE_SESSION_KEY_PREV`  | the server, at runtime | secret | Optional: the previous key, during a rotation                             |
| `GDRIVE_CLIENT_ID`         | the server, at runtime | plain  | Optional: falls back to `VITE_GDRIVE_CLIENT_ID`                           |
| `GDRIVE_POP`               | the server, at runtime | plain  | `off` only in an emergency (see below)                                    |

- **Never** give a secret a `VITE_` or `PUBLIC_` prefix: those are compiled into
  the client. The server reads its secrets through `$env/dynamic/private`, at
  request time. `npm run build` runs `scripts/check-no-server-secrets.mjs`,
  which fails the build if the value of any secret set in its environment
  appears in the output (CI builds with canary values).
- **Define nothing secret at a scope that every branch build can read.** A
  branch that changes the build could print it. A build with the flag but
  without the secrets answers `501 not_configured`, and the client falls back
  to the popup flow for that tab.
- If any secret is missing, empty or malformed (a key that is not 32 bytes, or
  a bad `_PREV`), every route answers 501. A typo is loud, never a silent
  sign-out.

### Google Cloud Console (each client)

1. **Publishing status: In production.** In "Testing", refresh tokens expire
   after 7 days.
2. **Authorized redirect URIs:** each environment's origin +
   `/oauth/google-callback.html`. For local development, add
   `http://localhost:<port>/oauth/google-callback.html` on a non-production
   client only.
3. Keep the **Authorized JavaScript origins**: the popup fallback and the
   Picker still use them.
4. **Client secret:** create a new one, and paste it straight into the hosting
   provider's secret store. Never put it in a file.

### Local development

Put the four variables in `.env.local` with a non-production client. Over plain
`http://localhost` the cookie is called `gdrive_rt` and is not `Secure`
(browsers refuse `__Host-` there). Everywhere else it is `__Host-gdrive_rt`.

## How it works

- **Sign-in** (a user's click only, never at startup). The client makes a PKCE
  verifier and a random `state`, and stores them in `sessionStorage` with the
  hash to return to. It also creates the **device key**: a non-extractable
  ECDSA P-256 key in its own IndexedDB database. Then it leaves for Google.
  Google redirects to the static callback page. The page drops the query,
  stashes `{code, state}` (only for a flow this tab started) and returns to the
  app. At startup the app checks `state` (one use) and POSTs the code to
  `/api/gdrive/session` with a proof. The server redeems it with the client
  secret, seals the refresh token into the cookie and returns only the access
  token.
- **Renewal.** `tokenManager.getAccessToken()` renews a token with less than 5
  minutes left (workers ask for 15). It first adopts a token another tab already
  wrote, then sends one request per tab. On a 401 from Drive the token is renewed
  once and the call is sent again. `getTimeUntilExpiry()` is `null` while the
  session can renew, so the countdown and the hourly popup are gone.
- **The cookie.** Its value is `v1.<kid>.<iv>.<ciphertext||tag>`, AES-256-GCM
  with a fresh 12-byte IV per seal. The additional data is
  `v1|kid|client_id|origin|cookie name`, so a cookie never opens on another
  deployment, client or name. It holds `{rt, iat0, ts, cnf?}`. The server
  rejects a session idle for 180 days (`ts`) or 365 days past its first consent
  (`iat0`). `ts` slides at most once a week.
- **Device binding.** A session signed in with a proof stores the key's RFC 7638
  thumbprint (`cnf`). Every refresh must then sign
  `mokuro-pop-v1|<origin>|POST|/api/gdrive/refresh|<ts>`, within 10 minutes of
  the server's clock. A client whose clock is off gets `pop_clock` with the
  server time and retries once. A copied cookie is useless without the key,
  and nothing ever re-binds an existing cookie. `/logout` needs no proof.

## Error vocabulary

Every answer is JSON with `Cache-Control: no-store`. Google's `error_description`
is never forwarded.

| Error                                                                                          | Status              | Meaning                                                                         | Cookie                                                | Client                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `no_session`                                                                                   | 401                 | No cookie                                                                       | —                                                     | Reconnect                                                       |
| `reauth`                                                                                       | 401                 | Cookie unreadable or expired, Google `invalid_grant`, or a failed proof         | cleared (kept on a failed proof or an unknown key id) | Reconnect                                                       |
| `pop_clock`                                                                                    | 401                 | Proof timestamp off by more than 10 minutes (`serverTime` included)             | kept                                                  | Adopts the offset, retries once                                 |
| `server_config`                                                                                | 503                 | `invalid_client`, `deleted_client`, `unauthorized_client`, `invalid_request`, … | **kept**                                              | Keeps a valid token, retries later                              |
| `transient`                                                                                    | 503                 | Google 5xx, 429, a timeout (5 s) or a network failure                           | kept                                                  | Same; after 3 with an expired token, Reconnect offers the popup |
| `consent_incomplete`                                                                           | 403                 | No refresh token, or no Drive scope (the grant is revoked)                      | —                                                     | "Allow Drive access"                                            |
| `not_configured`                                                                               | 501                 | Secrets missing or malformed                                                    | —                                                     | Popup flow for this tab                                         |
| `forbidden`                                                                                    | 403                 | Origin, `Sec-Fetch-Site` or `X-Requested-With` check failed                     | —                                                     | —                                                               |
| `bad_request`, `payload_too_large`, `unsupported_media_type`, `method_not_allowed`, `internal` | 400/413/415/405/500 | —                                                                               | —                                                     | —                                                               |

Of Google's answers, only `invalid_grant` clears a cookie. A rotated or
mistyped secret, or a client Google deleted (it can be restored for 30 days),
keeps every session. So does a session key this deployment lacks: a cookie
whose key id matches neither `GDRIVE_SESSION_KEY` nor `GDRIVE_SESSION_KEY_PREV`
is answered `reauth` but KEPT (`cookie_unknown_kid`), because the fault is the
deployment's, not the cookie's. An Instant Rollback past a key rotation, or a
deployment given the wrong key, signs nobody out for good: once a deployment
holding the key serves again, those cookies refresh as before. A cookie that
fails under a key this deployment does hold (garbage, tampered, replayed from
another origin) is cleared.

### Signing out

Google revokes per Cloud project, not per OAuth client. Revoking one token
ends the user's whole grant: every device and browser using the reader, and
any mokuro-bunko server whose Drive client sits in the same project. So there
are two sign-outs:

- **This device** (the default: "Log out", a switch to another provider,
  `providerManager.logout()`). The client POSTs `/logout` with
  `{"everywhere": false}`; an absent body or field means the same. The server
  clears the cookie and does **not** call Google. The client deletes its
  device key from IndexedDB and drops its access token without revoking it
  (revoking an access token ends the whole grant too). A session bound to the
  deleted key can never refresh again, so a copy of its cookie is worthless
  even though the grant stays live for the other devices. Implicit mode
  forgets the token locally and revokes nothing.
- **Everywhere** ("Sign out everywhere…", confirmed in a modal; Drive only).
  `{"everywhere": true}`: the server revokes the refresh token at Google, then
  clears the cookie. Implicit mode revokes the access token as before. Both
  delete the device key.

`/logout` answers `200 {ok: true, revoked, invalidated}`. A malformed body
(`everywhere` not a boolean, bad JSON) is `400 bad_request` and changes
nothing. A device sign-out always says `revoked: false`, and the client never
takes that as a cue to revoke. `invalidated` says whether copies of the
cookie are now useless: for a device sign-out, everything except a live
unbound session, or any live session while `GDRIVE_POP=off` (no cookie, one
the server cannot open, or an expired one leaves nothing a copy could use);
for everywhere, the revoke. When
a device sign-out answers `invalidated: false` (or, offline, the browser never
had a device key), the snackbar says a copy could still work and points to
"Sign out everywhere". On an everywhere sign-out, `revoked` is true only when the
server ended the grant at Google. When it is false (Google down or slow, a
cookie sealed under a retired key, no cookie at all), the client revokes the
access token it holds itself: revoking either token of a grant ends the whole
grant. The cloud page says "Signed out of Google Drive everywhere" only when
one of the two revokes was confirmed (`logout()` answers `revoked`); otherwise
it says the sign-out is queued for the next Connect here (the request never
got through — offline, a timeout, the backend down: `pendingEverywhere`) or
that Google could not be reached (also when this host has no backend or the
server refused the request: no replay would finish it), and points to
myaccount.google.com/permissions. Implicit mode reports its revoke the same
way. The client remembers the scope (`gdrive_logout_pending` in
localStorage: `device` or `everywhere`; the older value `1` reads as
`everywhere`) and drops its token BEFORE the request goes out, so a reload
or a closed tab mid-request still finds the device signed out and the
sign-out queued; the flag is cleared once the server answers (or a revoke
from the browser got through). If the request does not get through (the
device is offline), the flag stays. Until a
later `/logout` with that scope gets through, it sends no refresh, so the
cookie left behind can never sign anyone back in without a consent screen. A
pending `everywhere` is never narrowed: the next sign-out is an everywhere
one too. For a pending device sign-out the key is already gone, so the cookie
cannot refresh even before the replay clears it. While a tab's own `/logout`
is out, that tab renews nothing (a 401 mid-sign-out gets no token), so no
replay of the queued sign-out races it with a second revoke of the same grant.

On `/session`, the code exchange and the revoke of a grant the server refuses
share one 8 s budget (`GOOGLE_BUDGET_MS`), under the routes' 10 s
`maxDuration`.

## Logs

The server writes one JSON line per request:
`{"scope":"gdrive-auth","route","status","event","googleError"?,"kid"?}`.
It never logs a token, a code, a cookie or a body. Events include
`signed_in(_bound)`, `refreshed(_resealed)`, `no_cookie`, `cookie_<reason>`,
`expired`, `pop_missing`, `pop_mismatch`, `pop_clock`, `grant_revoked`,
`server_config`, `transient`, `revoked`, `revoke_failed`,
`device_cleared`, `device_cleared_unbound`, `device_cleared_pop_off`,
`bad_scope` and `not_configured`.

## Runbook

- **Contain an incident.** Block `/api/gdrive/` at the firewall. Clients then
  see a non-JSON 403 and treat it as transient. Or unset
  `VITE_GDRIVE_AUTH_BACKEND` and redeploy: everyone falls back to the popup
  flow.
- **Sign out every session.** Set a new `GDRIVE_SESSION_KEY`, delete
  `GDRIVE_SESSION_KEY_PREV` and redeploy. Never roll back to an older deployment
  afterwards: it carries the old key, and the old cookies are still in the
  browsers (a deployment cannot tell a dropped key from one it was never
  given, so it keeps them), so the rollback would open them all again.
- **Rotate the session key without signing anyone out.** Move the current key
  to `GDRIVE_SESSION_KEY_PREV`, set a new `GDRIVE_SESSION_KEY` and redeploy.
  Each cookie is re-sealed with the new key on its next refresh. Drop `_PREV`
  once you no longer care about sessions idle since the rotation. A rollback
  past the rotation signs nobody out: the older deployment answers `reauth`
  to cookies re-sealed under the new key but keeps them, and they work again
  after rolling forward.
- **Rotate the client secret.** Add a second secret in the Console, set it as
  `GDRIVE_CLIENT_SECRET`, redeploy and confirm a refresh works. Then disable and
  delete the old secret. Existing refresh tokens survive this; check once.
- **The secret leaked together with refresh tokens.** Refresh tokens leave the
  server only sealed, but if both leaked anyway, delete the client (or have
  users revoke access in their Google account).
- **Device binding is failing.** `GDRIVE_POP=off` stops requiring proofs.
  Sign-ins still bind when they carry a valid one, so turning it back on
  later needs no new sign-ins.

## Known limits

- **There is no per-session revoke at Google.** "Sign out everywhere" ends
  the whole grant for the Cloud project: every device, browser and
  mokuro-bunko server using it. A device sign-out revokes nothing; it relies
  on the device key instead.
- **Unbound sessions and a device sign-out.** A session without `cnf` (the
  browser could not create or keep a device key, or the proof failed while
  `GDRIVE_POP=off`), and any session while `GDRIVE_POP=off`, is not protected
  by deleting the key. A copy of its cookie taken before the sign-out stays
  usable until it expires (180 days without use). The server answers
  `invalidated: false` and logs `device_cleared_unbound` or
  `device_cleared_pop_off`; the user is told to use "Sign out everywhere" to
  end it for sure. There is no revoke and no denylist for it (no database).
- **XSS.** While a tab is open, a script injected into the page can call
  `/refresh` and mint hour-long tokens. It cannot take the refresh token or
  the device key away with it. A Content-Security-Policy is the real defence,
  and it is a separate piece of work.
- **Safari.** Safari deletes script-writable storage (IndexedDB, localStorage)
  after 7 days of use without a visit. The device key goes with it, so a bound
  session needs a fresh consent after such a gap (the cookie itself survives).
- **Not built.** Google DPoP, Device Bound Session Credentials, RISC and rate
  limiting.
