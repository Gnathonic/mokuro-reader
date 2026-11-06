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

| Piece             | Where                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- |
| Routes            | `src/routes/api/gdrive/{session,refresh,logout}/+server.ts`                           |
| Server logic      | `src/lib/server/gdrive-auth/` (server-only)                                           |
| Callback page     | `static/oauth/google-callback.{html,js}`                                              |
| Client            | `src/lib/util/sync/providers/google-drive/{auth-backend,device-key,token-manager}.ts` |
| Headers           | `vercel.json` (`/oauth/(.*)`, `/api/(.*)`)                                            |
| Service worker    | `src/service-worker.js` never touches `/api/` or `/oauth/`                            |
| Real-browser test | `e2e/gdrive-auth-backend.spec.ts`                                                     |

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

`/logout` always clears the cookie and answers `200 {ok: true, revoked}`.
`revoked` is true only when the server ended the grant at Google. When it is
false (Google down or slow, a cookie sealed under a retired key, no cookie at
all), the client revokes the access token it holds itself: revoking either
token of a grant ends the whole grant. If neither request gets through (the
device is offline), the client remembers that (`gdrive_logout_pending` in
localStorage). Until a later `/logout` gets through, it sends no refresh, so
the cookie left behind can never sign anyone back in without a consent screen.

On `/session`, the code exchange and the revoke of a grant the server refuses
share one 8 s budget (`GOOGLE_BUDGET_MS`), under the routes' 10 s
`maxDuration`.

## Logs

The server writes one JSON line per request:
`{"scope":"gdrive-auth","route","status","event","googleError"?,"kid"?}`.
It never logs a token, a code, a cookie or a body. Events include
`signed_in(_bound)`, `refreshed(_resealed)`, `no_cookie`, `cookie_<reason>`,
`expired`, `pop_missing`, `pop_mismatch`, `pop_clock`, `grant_revoked`,
`server_config`, `transient`, `revoked`, `revoke_failed` and `not_configured`.

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

- **Signing out revokes everywhere.** Google revokes the whole grant, so
  every device using this client is signed out. There is no per-session
  server revoke.
- **XSS.** While a tab is open, a script injected into the page can call
  `/refresh` and mint hour-long tokens. It cannot take the refresh token or
  the device key away with it. A Content-Security-Policy is the real defence,
  and it is a separate piece of work.
- **Safari.** Safari deletes script-writable storage (IndexedDB, localStorage)
  after 7 days of use without a visit. The device key goes with it, so a bound
  session needs a fresh consent after such a gap (the cookie itself survives).
- **Not built.** Google DPoP, Device Bound Session Credentials, RISC and rate
  limiting.
