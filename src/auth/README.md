# Road Cruise — Enterprise Auth Platform

Authoritative documentation for the authentication platform under `server/src/auth/`. This started
as an additive **"Continue with Google"** OAuth module and has since been **hardened in place** into a
full enterprise auth platform: hashed passwords with transparent legacy migration, JWT
access/refresh tokens with rotation and reuse detection, device-aware sessions with remote revoke,
account lockout + per-IP rate limiting, single-use hashed reset/verification tokens, RBAC, and an
immutable audit trail.

> **Source of truth:** this document is derived directly from the implementation
> (`config/auth.config.js`, `core/*`, `rbac/*`, `providers/*`, `api/*`, `index.js`), the hardened
> `src/controllers/auth.controller.js` + `src/routes/auth.routes.js`, the notification additions
> (`src/notifications/config/events.js`, `workflows/registry.js`), `src/app.js`, the auth section of
> `.env.example`, and `package.json`. Where behavior is not yet implemented or is deliberately not
> retrofitted, it is called out under **§13 Honest Limitations / Extension Points**.

> **Prime directive — additive / non-breaking.** Everything here is layered so pre-existing
> email/password users, the existing frontend, and the existing booking/payment routes keep working
> **unchanged**. The public response contracts of `POST /api/auth/login` and `/register` are preserved
> exactly; the platform only *adds* fields and *adds* routes.

---

## Table of Contents

1. [Security Model Overview](#1-security-model-overview)
2. [Login Flow](#2-login-flow)
3. [Password Migration](#3-password-migration-transparent)
4. [User Model](#4-user-model)
5. [RBAC](#5-rbac)
6. [API Reference](#6-api-reference)
7. [Feature Flags](#7-feature-flags)
8. [Environment Variables](#8-environment-variables)
9. [Migration / Deployment / Recovery / Rollback Guide](#9-migration--deployment--recovery--rollback-guide)
10. [Audit Trail](#10-audit-trail)
11. [Google OAuth 2.0 (existing module)](#11-google-oauth-20-existing-module)
12. [Google Cloud Console Setup & Frontend Integration](#12-google-cloud-console-setup--frontend-integration)
13. [Honest Limitations / Extension Points](#13-honest-limitations--extension-points)

---

## 1. Security Model Overview

| Control | Implementation | Where |
|---|---|---|
| **Password hashing** | Self-describing `<algo>$<params>` hashes. Default **scrypt** (Node built-in, memory-hard, zero native deps). `AUTH_PASSWORD_ALGO=argon2\|bcrypt` switches to those, **lazy-loaded** — if the optional package is missing, it logs a warning and **falls back to scrypt** so the app never breaks. Per-hash random salt, constant-time compare. | `core/password.js` |
| **Never plaintext / never logged / never exposed** | Passwords are hashed before storage; hashes are never logged. `sanitize()` strips `passwordHash`, `password`, `passwordAlgorithm`, `passwordMigrated`, `lastPasswordChange`, all token hashes, and lockout/`tokenVersion` state before any user object is returned to a client. | `core/userService.js` (`SENSITIVE_FIELDS`, `sanitize()`) |
| **Transparent legacy migration** | A stored value with no recognized `algo$` prefix is treated as legacy **plaintext**, compared constant-time, and on a successful login **rehashed** into the configured algorithm — no reset, no downtime. | `core/password.js` + `core/AuthService.authenticateLocal` |
| **JWT access + refresh** | HS256, algorithm pinned (no `alg:none` downgrade). **Access token 15 min** (`accessTtlSec`), **refresh token 30 days** (`refreshTtlSec`). Access carries `email/role/tokenVersion/sid`; refresh carries `sid + rotating jti`. | `core/token.js` |
| **Refresh rotation + reuse detection** | Each refresh issues a **new** refresh with a new `jti` and rotates the session's stored `jti`. A presented refresh whose `jti` ≠ the session's current `jti` is a **replay** → the session is revoked and `TOKEN_REUSE_DETECTED` is audited. | `core/AuthService.refresh` |
| **tokenVersion revocation** | Every user has a `tokenVersion`. `logout-all` and password reset **bump** it, which instantly invalidates every outstanding access + refresh token for that user (the middleware/refresh path compares versions). | `core/userService.bumpTokenVersion`, `rbac/middleware.js` |
| **Device-aware sessions** | One record per (user, device) login, with parsed device/browser/OS + IP + UA. Supports **remote revoke** (single session), **revoke all** (logout-all), and **admin revoke**. | `core/sessionStore.js` |
| **Account lockout** | Per-account failed-attempt counter within a sliding window; after `maxAttempts` (default 5) the account is locked for `lockMs` (default 15 min). Complementary to rate limiting. | `core/userService.recordFailedLogin` |
| **Per-IP rate limiting** | Dependency-free sliding-window limiter keyed by `ip+route`. `loginLimiter` (default 10/min) on login/register/google/refresh; `sensitiveLimiter` (default 5/min) on forgot/reset/verify. Returns `429` + `Retry-After`. | `core/rateLimiter.js` |
| **Single-use hashed reset/verification tokens** | Reset & email-verification tokens are 32-byte random values; **only their SHA-256 hash is stored**, with an expiry. Consuming a token clears it on **any** attempt (single-use, no reuse), and validity is checked against the hash + expiry. | `core/userService.js` (`setResetToken`/`consumeResetToken`, `setVerificationToken`/`consumeVerificationToken`) |
| **RBAC** | Hierarchical roles + permission matrix; `requireAuth`/`requireRole`/`requirePermission` middleware. | `rbac/roles.js`, `rbac/middleware.js` |
| **Immutable audit trail** | Append-only JSON log of every security-relevant event. Never stores passwords or token secrets. | `core/auditLog.js` |
| **OAuth replay protection** | One-time, TTL-bounded, timing-safe **nonce** burned on consume. | `core/nonceStore.js` |
| **Fail-closed in production** | `init()` **throws** in production if Google runs in mock mode (no `GOOGLE_CLIENT_ID`) or `JWT_SECRET` is still the dev default. The mock Google verifier also self-disables in production. | `index.js`, `config/auth.config.js`, `providers/GoogleProvider.js` |

### Self-describing hash formats (`core/password.js`)

```
scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>     # default (N=16384, r=8, p=1, keylen=32)
argon2$<argon2id-encoded>                   # when 'argon2' is installed
bcrypt$<bcrypt-hash>                         # when 'bcrypt'/'bcryptjs' is installed
<no algo$ prefix>                            # treated as legacy PLAINTEXT → migrated on next login
```

`verifyPassword()` routes by prefix; `isLegacyPlaintext()` / `needsPasswordMigration()` detect
records that still need migrating. The password **policy** (`core/passwordPolicy.js`) is enforced on
**register** and **reset** only — **not on login**, so a legacy user with a weak password can still
log in and be migrated.

---

## 2. Login Flow

`POST /api/auth/login` (hardened in place — `src/controllers/auth.controller.js` → `AuthService.authenticateLocal`):

```
  POST /api/auth/login  { email, password }
        │
        ▼
  loginLimiter (per-IP)  ──429──►  Too many requests
        │
        ▼
  findByEmail(email)     ──none──►  audit LOGIN_FAILED(no_user)   ──►  401 Invalid email or password
        │
        ▼
  isLocked(user)?        ──yes──►  audit LOGIN_LOCKED             ──►  423 Account temporarily locked
        │ no
        ▼
  verifyPassword(pwd, storedCredential(user))   (hash OR legacy plaintext, constant-time)
        │
        ├─ fail ─► recordFailedLogin → audit LOGIN_FAILED(bad_password)
        │           (if now locked → audit ACCOUNT_LOCKED)         ──►  401 Invalid email or password
        │
        └─ ok
            ▼
        resetFailedLogins(email)
            ▼
        needsPasswordMigration(user)?  ── yes ──►  hashPassword(pwd) → setPasswordHash(...)
            │                                       audit PASSWORD_MIGRATED   [see §3]
            ▼
        touchLastLogin(email)
            ▼
        _issueSession:  createSession(device/ip/ua, refreshJti)
                        signAccessToken (15m)  +  signRefreshToken (30d, bound to sid+jti)
            ▼
        audit LOGIN_SUCCESS { sid }
            ▼
        200  { ...sanitized user, accessToken, refreshToken, sessionId }
```

**Response contract is unchanged.** Success is still **HTTP 200** with the **same sanitized user
object** the legacy login returned. The only difference is three **additive** fields —
`accessToken`, `refreshToken`, `sessionId` — which the existing frontend safely ignores (it continues
to store the user object in `localStorage['rc_user']` exactly as before). `POST /api/auth/register`
likewise preserves its non-standard **211** success status, adding the same three fields. Error codes
are preserved (`400` validation/weak-password, `401` bad credentials, `409` email exists) with `423`
added for lockout.

---

## 3. Password Migration (transparent)

**Transparent, no reset, no downtime.** Legacy accounts store the password as **plaintext** in the
`password` field (the old scheme). The platform migrates them to a proper hash **the first time the
user logs in successfully** — the user never notices and never has to reset.

Exact behavior (`core/password.js` + `AuthService.authenticateLocal`):

1. `storedCredential(user)` returns `user.passwordHash ?? user.password ?? null` — so verification
   prefers the hash and falls back to the legacy plaintext.
2. `verifyPassword(password, stored)` inspects the stored value's prefix:
   - `scrypt$` / `argon2$` / `bcrypt$` → route to the matching verifier.
   - **No recognized prefix → legacy plaintext**: constant-time (`timingSafeEqual`) comparison.
3. On a **successful** login where `needsPasswordMigration(user)` is true (i.e. `passwordHash` absent
   but `password` present), the service:
   - computes `hashPassword(password)` with the configured algorithm,
   - calls `setPasswordHash(email, hash, algo, { migrated: true })`, which writes `passwordHash`,
     `passwordAlgorithm`, `passwordMigrated: true`, `lastPasswordChange`, and **deletes the legacy
     `password` field**,
   - writes an audit record `PASSWORD_MIGRATED`.
4. A **failed** login never migrates (the plaintext stays until a correct password is presented).

Because migration is keyed off the presence of a hash, it is naturally **idempotent** — once migrated
the plaintext is gone and subsequent logins verify against the hash. Users who never log in again keep
their legacy value harmlessly until they do (or you can run the optional
`userService.migrateLegacyUsers()` backfill, which normalizes *additive identity fields* but **never
touches passwords** — see §4).

---

## 4. User Model

Users live in the existing `db.json` `users[]` array via the existing `utils/db.js`. **All fields
below are additive** — legacy users are read with sane defaults and only gain fields as they log in,
register, reset, or link. **Preserved existing fields:** `name`, `email`, `password` (legacy
plaintext, removed on migration), `role`, `phone`.

### Additive field set (`core/userService.js`)

| Field | Type | Meaning |
|---|---|---|
| `passwordHash` | string | Self-describing hash (`scrypt$…` etc.). Replaces `password` after migration/register. |
| `passwordAlgorithm` | string | Algorithm used for `passwordHash` (`scrypt`/`argon2`/`bcrypt`). |
| `passwordMigrated` | boolean | `true` once a proper hash is stored. |
| `lastPasswordChange` | ISO string | Set on hash write (register / migration / reset). |
| `tokenVersion` | number | Bumped by logout-all / reset; invalidates all outstanding tokens. |
| `emailVerified` | boolean | `true` for Google accounts and after email verification. |
| `failedLoginAttempts` | number | Failed logins in the current window. |
| `failedLoginWindowStart` | ISO string \| null | Start of the current failed-attempt window. |
| `lockedUntil` | ISO string \| null | Lockout expiry; `isLocked()` compares against now. |
| `lastLogin` | ISO string \| null | Updated on each successful login. |
| `provider` | string | Primary provider label (`"local"`, `"google"`). |
| `authProvider` | string | Provider(s) used; comma-joined when linked (e.g. `"local,google"`). |
| `providers` | string[] | De-duplicated list of linked providers. |
| `googleId` | string \| null | Google subject (`sub`); key for `findByGoogleId`. |
| `avatar` | string \| null | Profile picture URL (Google; https-only). |
| `resetTokenHash` | string | SHA-256 of the reset token (never the token itself). Cleared on consume. |
| `resetTokenExpiry` | ISO string | Reset-token expiry. |
| `verificationTokenHash` | string | SHA-256 of the verification token. Cleared on consume. |
| `verificationTokenExpiry` | ISO string | Verification-token expiry. |
| `roleChangedBy` / `roleChangedAt` | string / ISO | Set by `setRole()` (audited role change metadata). |

**All additive; legacy users work with defaults.** Any of these absent is treated as its default
(`tokenVersion ?? 0`, `failedLoginAttempts ?? 0`, `emailVerified ?? false`, etc.), so a pre-existing
`{ name, email, password, role, phone }` record authenticates without change and is upgraded lazily.

- A **Google-only** account is created with `password: null` (no local password).
- A new **local** account (`createLocalUser`) is created with `passwordHash`, `passwordAlgorithm`,
  `passwordMigrated: true`, `tokenVersion: 0`, `emailVerified: false`.
- **Linking** Google onto a local account merges providers and sets `googleId`/`avatar`/`emailVerified`
  without overwriting the password or profile.

### `migrateLegacyUsers()` — optional backfill

`userService.migrateLegacyUsers()` backfills the additive **identity** fields on legacy users
(`provider`/`authProvider`/`providers`/`googleId`/`avatar`/`emailVerified`/`lastLogin` defaults). It is
**idempotent** (skips users that already have `provider` + `authProvider`), **non-destructive** (never
overwrites, **never touches passwords**), and **not auto-run** — call it manually if you want legacy
records normalized. Password migration itself happens automatically on login (§3), independent of this.

---

## 5. RBAC

`rbac/roles.js` defines a **hierarchical** role model and a permission matrix; `rbac/middleware.js`
enforces it.

### Role hierarchy (by rank — higher inherits lower)

```
super_admin (100)  >  admin (80)  >  manager (60)  >  staff (40)  >  driver (30)  >  customer (10)
```

The legacy app only used `admin` and `customer`; both map cleanly into this matrix, so no existing
role breaks. `normalizeRole()` lower-cases and defaults unknown roles to `customer`.

### Permission matrix (effective, after hierarchy inheritance)

Each role inherits **all** permissions of every lower-ranked role, plus its own direct grants:

| Permission | customer | driver | staff | manager | admin | super_admin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `self:read`, `self:manage` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `booking:read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `booking:write` | | | ✅ | ✅ | ✅ | ✅ |
| `payment:read` | | | ✅ | ✅ | ✅ | ✅ |
| `user:read` | | | ✅ | ✅ | ✅ | ✅ |
| `booking:delete` | | | | ✅ | ✅ | ✅ |
| `payment:refund` | | | | ✅ | ✅ | ✅ |
| `notification:manage` | | | | ✅ | ✅ | ✅ |
| `audit:read` | | | | ✅ | ✅ | ✅ |
| `user:manage` | | | | | ✅ | ✅ |
| `session:manage` | | | | | ✅ | ✅ |
| `role:manage` | | | | | | ✅ |

> Note: `driver` and `customer` share the same direct grants; because inheritance is strictly by rank,
> `staff` and above accumulate everything below them.

### Middleware

- **`requireAuth`** — extracts the Bearer access token (or `body.accessToken` / `query.access_token`),
  verifies it as a typed `access` token (`verifyTyped`), then checks the user still exists, the token's
  `tokenVersion` matches the user's current `tokenVersion` (else `401 Token revoked`), and — if the
  token carries a `sid` — that the **session is still active** (supports remote/admin revoke). On
  success attaches `req.auth = { email, role, sid, user }`. Failures → `401`.
- **`requireRole(minRole)`** — `[requireAuth, …]`; then `roleAtLeast(req.auth.role, minRole)` or `403
  Insufficient role`.
- **`requirePermission(perm)`** — `[requireAuth, …]`; then `hasPermission(req.auth.role, perm)` or
  `403 Missing permission`.
- **`optionalAuth`** — attaches `req.auth` if a valid token is present, otherwise continues
  unauthenticated.

> **IMPORTANT — RBAC is applied to the NEW auth endpoints but NOT retrofitted onto existing
> booking/payment routes.** The current frontend is **tokenless** (it stores only the user object,
> not a bearer token), so retrofitting `requireAuth` onto `/api/bookings` etc. would break it.
> The middleware is **ready for adoption**: once clients start sending the access token, protecting
> those routes is a one-line `requireAuth` / `requirePermission` addition per route.

---

## 6. API Reference

All routes mount at `/api/auth`. The hardened `login`/`register` live in `src/routes/auth.routes.js`;
everything else in `src/auth/api/auth.routes.js` (mounted additively on the same prefix). Rate-limited
endpoints are marked. `<BASE>` below = `http://localhost:5000`.

### `POST /api/auth/login` — local login (hardened, same contract) · *rate-limited (login)*

- **Body:** `{ "email": "...", "password": "..." }`
- **Auth:** none.
- **200** `{ ...user, accessToken, refreshToken, sessionId }` (same user shape as before + additive fields)
- **400** validation · **401** invalid credentials · **423** account locked · **429** rate-limited · **500** error

```bash
curl -X POST <BASE>/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"S3cret!pass"}'
```

### `POST /api/auth/register` — local register (hardened, same contract) · *rate-limited (login)*

- **Body:** `{ "name": "...", "email": "...", "phone": "...", "password": "..." }`
- **Auth:** none. Enforces the password policy; sends a verification email if enabled.
- **211** `{ ...user, accessToken, refreshToken, sessionId }` (preserved non-standard success status)
- **400** validation / weak password · **409** email exists · **429** rate-limited · **500** error

```bash
curl -X POST <BASE>/api/auth/register -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","phone":"+91 99999 99999","password":"S3cret!pass"}'
```

### `POST /api/auth/google` — Google login/create/link · *rate-limited (login)*

- **Body:** `{ "idToken": "<google-id-token>", "nonce": "<nonce>" }` (nonce mandatory in prod)
- **Auth:** none. Returns the sanitized user + `token` (== access token), `accessToken`, `refreshToken`,
  `sessionId`, `firstLogin`, `linked`.
- **200** success · **400** missing `idToken` / bad-or-used nonce · **401** token rejected · **409**
  `LINK_REQUIRED` · **503** OAuth disabled or `google-auth-library` missing · **500** error

```bash
curl -X POST <BASE>/api/auth/google -H "Content-Type: application/json" \
  -d '{"idToken":"<GOOGLE_ID_TOKEN_FROM_GIS>","nonce":"<NONCE_FROM_/nonce>"}'
```

### `GET /api/auth/google/config` — public bootstrap (no secrets)

```bash
curl <BASE>/api/auth/google/config
# 200 { "enabled": true, "mode": "mock", "clientId": null }
```

### `GET /api/auth/nonce` — one-time nonce

```bash
curl <BASE>/api/auth/nonce
# 200 { "nonce": "…", "ttl": 600 }
```

### `POST /api/auth/refresh` — rotate refresh → new access+refresh · *rate-limited (login)*

- **Body:** `{ "refreshToken": "..." }`
- **Auth:** the refresh token itself. Detects reuse (revokes the session).
- **200** `{ accessToken, refreshToken }` · **400** refresh disabled · **401** invalid / revoked /
  reuse-detected · **429** rate-limited

```bash
curl -X POST <BASE>/api/auth/refresh -H "Content-Type: application/json" \
  -d '{"refreshToken":"<REFRESH_TOKEN>"}'
```

### `GET /api/auth/me` — current user + permissions · **requireAuth**

```bash
curl <BASE>/api/auth/me -H "Authorization: Bearer <ACCESS_TOKEN>"
# 200 { ...sanitized user, permissions: ["self:read", ...], sessionId }
```
- **401** missing/invalid/revoked token or inactive session.

### `POST /api/auth/logout` — revoke current session · **requireAuth**

```bash
curl -X POST <BASE>/api/auth/logout -H "Authorization: Bearer <ACCESS_TOKEN>"
# 200 { ok: true }
```

### `POST /api/auth/logout-all` — revoke ALL sessions (bumps tokenVersion) · **requireAuth**

```bash
curl -X POST <BASE>/api/auth/logout-all -H "Authorization: Bearer <ACCESS_TOKEN>"
# 200 { ok: true, revoked: <n> }
```

### `GET /api/auth/sessions` — list my active sessions · **requireAuth**

```bash
curl <BASE>/api/auth/sessions -H "Authorization: Bearer <ACCESS_TOKEN>"
# 200 { sessions: [ { sessionId, device, browser, os, ip, provider, createdAt, lastActive, expiresAt, current } ] }
```

### `DELETE /api/auth/sessions/:sid` — revoke one of my sessions · **requireAuth**

```bash
curl -X DELETE <BASE>/api/auth/sessions/<SID> -H "Authorization: Bearer <ACCESS_TOKEN>"
# 200 { ok: true }   ·   404 not found   ·   403 not your session
```

### `POST /api/auth/forgot-password` — request reset link · *rate-limited (sensitive)*

- **Body:** `{ "email": "..." }`  · **Auth:** none.
- **200** always `{ ok: true, message: "If an account exists, a reset link has been sent." }` (no
  account enumeration). · **429** rate-limited.

```bash
curl -X POST <BASE>/api/auth/forgot-password -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com"}'
```

### `POST /api/auth/reset-password` — reset with single-use token · *rate-limited (sensitive)*

- **Body:** `{ "email": "...", "token": "...", "newPassword": "..." }` · **Auth:** the reset token.
  Enforces policy; **bumps tokenVersion + revokes all sessions**.
- **200** `{ ok: true }` · **400** weak password or invalid/expired token · **429** rate-limited.

```bash
curl -X POST <BASE>/api/auth/reset-password -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","token":"<RESET_TOKEN>","newPassword":"N3w!secret"}'
```

### `POST /api/auth/verify-email` — verify with single-use token · *rate-limited (sensitive)*

- **Body (or query):** `{ "email": "...", "token": "..." }` · **Auth:** the verification token.
- **200** `{ ok: true }` · **400** invalid/expired token · **429** rate-limited.

```bash
curl -X POST <BASE>/api/auth/verify-email -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","token":"<VERIFY_TOKEN>"}'
```

### `POST /api/auth/resend-verification` — resend verification email · *rate-limited (sensitive)*

- **Body:** `{ "email": "..." }` · **Auth:** none.
- **200** always `{ ok: true }` (no enumeration; only sends if the account exists and is unverified).

```bash
curl -X POST <BASE>/api/auth/resend-verification -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com"}'
```

---

## 7. Feature Flags

Read at boot from env into `config.flags` (`config/auth.config.js`). All default **`true`**.

| Flag env var | Default | Effect when off |
|---|---|---|
| `AUTH_ENABLED` | `true` | (Alias for the auth master switch in `config.flags.auth`.) |
| `GOOGLE_AUTH_ENABLED` | `true` | Disables the Google auth feature flag. |
| `EMAIL_VERIFICATION_ENABLED` | `true` | Register no longer sends a verification email (`_sendVerification` skipped). |
| `PASSWORD_RESET_ENABLED` | `true` | `requestPasswordReset` short-circuits to `{ ok: true }` without issuing a token. |
| `JWT_ENABLED` | `true` | JWT feature flag. |
| `REFRESH_TOKEN_ENABLED` | `true` | No refresh token is issued on login/register/google; `/refresh` returns `400 DISABLED`. |

> **Note on the OAuth master switch.** `OAUTH_ENABLED` (distinct from `AUTH_ENABLED`) is the hard
> mount switch checked in `index.js`: `false` means the additive `/api/auth/*` router does **not**
> mount at all — a clean instant rollback (the hardened `login`/`register` still work because their
> router is mounted separately in `src/app.js`).

---

## 8. Environment Variables

From `config/auth.config.js` + `.env.example`. `int(...)`/`bool(...)` coercion with the listed defaults.

| Variable | Default | Mandatory in prod? | Purpose |
|---|---|---|---|
| `OAUTH_ENABLED` | `true` | no | Master mount switch for the additive router (rollback = `false`). |
| `AUTH_ENABLED` / `GOOGLE_AUTH_ENABLED` / `EMAIL_VERIFICATION_ENABLED` / `PASSWORD_RESET_ENABLED` / `JWT_ENABLED` / `REFRESH_TOKEN_ENABLED` | `true` | no | Feature flags (§7). |
| `GOOGLE_CLIENT_ID` | `null` | **yes** | Setting it activates **real** Google verification. In prod, mock mode makes `init()` throw. |
| `GOOGLE_CLIENT_SECRET` | `null` | recommended | Reserved for a future redirect/code-exchange flow (env-only). |
| `GOOGLE_CALLBACK_URL` | `null` | as needed | Reserved for redirect-based flows. |
| `JWT_SECRET` | `dev_auth_secret_change_me` | **yes** | HS256 signing secret for access/refresh/session tokens. In prod, the dev default makes `init()` throw. Falls back to `AUTH_SESSION_SECRET` if unset. |
| `AUTH_TOKEN_TTL_SEC` | `604800` (7d) | no | Default `signToken` TTL (legacy Google `token`). |
| `OAUTH_MOCK_SECRET` | `oauth_mock_secret` | no (dev/test only) | HMAC secret for the mock Google verifier (disabled in prod). |
| `OAUTH_AUTOLINK` | `true` | no | Auto-link Google to an existing local account on a verified email; `false` → `409 LINK_REQUIRED`. |
| `OAUTH_NONCE_TTL_SEC` | `600` | no | Nonce lifetime (seconds). |
| `AUTH_PASSWORD_ALGO` | `scrypt` | no | `scrypt` \| `argon2` \| `bcrypt` (latter two lazy-loaded; fall back to scrypt if missing). |
| `PASSWORD_MIN_LENGTH` | `8` | no | Policy: minimum length. |
| `PASSWORD_REQUIRE_UPPER` / `_LOWER` / `_NUMBER` / `_SPECIAL` | `true` | no | Policy: character-class requirements. |
| `ACCESS_TOKEN_TTL_SEC` | `900` (15m) | no | Access token lifetime. |
| `REFRESH_TOKEN_TTL_SEC` | `2592000` (30d) | no | Refresh token + session lifetime. |
| `AUTH_MAX_FAILED_ATTEMPTS` | `5` | no | Lockout threshold. |
| `AUTH_LOCK_MS` | `900000` (15m) | no | Lockout duration. |
| `AUTH_ATTEMPT_WINDOW_MS` | `900000` (15m) | no | Failed-attempt sliding window. |
| `AUTH_RATE_WINDOW_MS` | `60000` (1m) | no | Rate-limit window. |
| `AUTH_RATE_MAX_LOGIN` | `10` | no | Max login/register/google/refresh per IP per window. |
| `AUTH_RATE_MAX_SENSITIVE` | `5` | no | Max forgot/reset/verify per IP per window. |
| `RESET_TOKEN_TTL_SEC` | `1800` (30m) | no | Reset-token lifetime. |
| `VERIFY_TOKEN_TTL_SEC` | `86400` (24h) | no | Verification-token lifetime. |
| `APP_BASE_URL` | `http://localhost:5173` | recommended | Base URL used to build reset/verification links in emails. |
| `DEFAULT_USER_PHONE` | `+91 99999 99999` | no | Default phone for provisioned accounts. |

**`validateEnv()` never throws** — it returns `{ ok, errors, warnings }`. The two **hard errors in
production** (which cause `init()` to throw and refuse to boot) are: (1) mock Google mode (no
`GOOGLE_CLIENT_ID`), and (2) `JWT_SECRET` still at the dev default. In non-prod these are logged as
warnings and the server boots.

---

## 9. Migration / Deployment / Recovery / Rollback Guide

### Staged migration (zero downtime)

1. **Ship as-is.** Defaults are `scrypt` hashing + **mock** Google + all feature flags on. The module
   mounts and runs offline with no credentials.
2. **Existing plaintext users auto-migrate on next login** (§3) — no reset email, no downtime. No
   action required; optionally run `userService.migrateLegacyUsers()` once to normalize additive
   identity fields (does **not** touch passwords).
3. **Upgrade the hash (optional):** `npm i argon2` (or `bcryptjs`) and set `AUTH_PASSWORD_ALGO=argon2`.
   New hashes use argon2; existing scrypt/legacy hashes keep verifying (self-describing formats), and
   are re-hashed to argon2 the next time the user resets or (for plaintext) logs in.
4. **Go production:** set `JWT_SECRET` (strong random) and `GOOGLE_CLIENT_ID` (+ `npm i
   google-auth-library`), and `NODE_ENV=production`. Without these two, `init()` **throws** and the
   server refuses to start (fail-closed).

### Deployment checklist (production)

- `NODE_ENV=production`
- `JWT_SECRET` = strong random (not the dev default)
- `GOOGLE_CLIENT_ID` (+ `GOOGLE_CLIENT_SECRET`) set; `npm i google-auth-library`
- `APP_BASE_URL` = your real frontend origin (so reset/verify links are correct)
- Optionally `npm i argon2` + `AUTH_PASSWORD_ALGO=argon2`
- Configure Google Cloud origins/redirect URIs (§12)

### Recovery (forgot / reset)

`POST /forgot-password` → always `200` (no enumeration); if the account exists, a 32-byte token is
minted, **hashed + stored** with a 30-min expiry, and a `PASSWORD_RESET` notification with a
`resetLink` (`APP_BASE_URL/reset-password?email=…&token=…`) is emitted. `POST /reset-password`
consumes the single-use token, enforces the policy, sets the new hash, **bumps `tokenVersion` and
revokes all sessions** (so every device is signed out). Email verification works the same way via
`EMAIL_VERIFICATION` / `verificationLink`.

### Rollback

- **Full rollback:** `OAUTH_ENABLED=false` → the additive router does not mount. The hardened
  `login`/`register` still function (separate mount), just without the extra `/me`, `/sessions`,
  `/refresh`, recovery, and Google endpoints.
- **Granular rollback:** flip the relevant feature flag (§7) — e.g. `REFRESH_TOKEN_ENABLED=false`,
  `EMAIL_VERIFICATION_ENABLED=false`, `PASSWORD_RESET_ENABLED=false`.

---

## 10. Audit Trail

`core/auditLog.js` is an **immutable, append-only** log. Entries are never updated or deleted and
**never contain passwords or token secrets**. Records go to **`src/auth/data/auth_audit.json`**
(under `entries[]`, via the shared atomic `JsonStore`). Each entry:
`{ auditId, at, action, actor, email, ip, userAgent, result, detail }`.

### `AuditActions` catalog

| Action | Emitted when |
|---|---|
| `login_success` | Successful local login. |
| `login_failed` | Login failed (`no_user` / `bad_password`). |
| `login_locked` | Login attempt against a locked account. |
| `google_login` | Successful Google login/create/link. |
| `register` | New local account registered. |
| `password_migrated` | Legacy plaintext rehashed on login (§3). |
| `password_changed` | Password change (catalog entry). |
| `password_reset_requested` | `forgot-password` for an existing account. |
| `password_reset_completed` | Reset attempt (result `ok` or `invalid_token`). |
| `email_verify_requested` | Verification email (re)sent. |
| `email_verified` | Email verification succeeded. |
| `token_refreshed` | Refresh rotated successfully. |
| `token_reuse_detected` | Refresh replay → session revoked. |
| `logout` | Single-session logout. |
| `logout_all` | All-sessions logout (tokenVersion bump). |
| `session_revoked` | A session revoked (self/admin). |
| `role_changed` | Role changed (catalog entry). |
| `account_locked` | Account crossed the lockout threshold. |
| `account_unlocked` | Account unlocked (catalog entry). |
| `suspicious_activity` | Reserved for suspicious-activity flags. |

`query({ email, action, limit, offset })` reads back the trail (newest first).

---

## 11. Google OAuth 2.0 (existing module)

This is the original additive OAuth capability, now sitting inside the hardened platform.

### Coexistence & response shape

`POST /api/auth/google` returns the **same sanitized user shape** as local login so the frontend can
store it in `localStorage['rc_user']` unchanged, plus additive `token` (== access token),
`accessToken`, `refreshToken`, `sessionId`, `firstLogin`, `linked`:

```jsonc
{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "role": "customer",
  "provider": "google",
  "authProvider": "google",
  "providers": ["google"],
  "googleId": "1122334455",
  "avatar": "https://lh3.googleusercontent.com/...",
  "emailVerified": true,
  "lastLogin": "2026-07-01T10:00:00.000Z",
  "token": "<header>.<payload>.<hmac>",   // == accessToken (backward-compat)
  "accessToken": "…",
  "refreshToken": "…",
  "sessionId": "sess_…",
  "firstLogin": true,
  "linked": false
}
```

### Flow

1. Frontend `GET /api/auth/google/config` → mode + public clientId. If disabled/mock, renders an
   "unconfigured" button.
2. `GET /api/auth/nonce` → one-time nonce, passed into GIS `initialize`.
3. User consents; GIS returns a signed **ID token** embedding the nonce.
4. `POST /api/auth/google { idToken, nonce }`.
5. Controller `consumeNonce(nonce)` — burned single-use; invalid/expired/used → `400`. (Mandatory in
   prod; optional in dev/mock.)
6. `GoogleProvider.authenticate` verifies the token (real via `google-auth-library` JWKS/audience/
   expiry, or mock via local HMAC) and enforces issuer ∈ Google issuers, `email_verified === true`,
   and nonce match. Avatar URLs are accepted only if `https://` (blocks `javascript:`/`data:`).
7. `AuthService`: by `googleId` → returning user; else by verified email → **link** (never duplicate;
   `409` if `OAUTH_AUTOLINK=false`); else → **create** (`firstLogin`, fires `notifyCustomerRegistered`).
8. Issue session + access/refresh tokens.

### Provider abstraction

Business logic (find/create/link/token) lives in `AuthService`; providers implement a single
`authenticate()` → normalized `{ provider, sub, email, emailVerified, name, picture }`
(`providers/AuthProvider.js`). Registry (`providers/index.js`): `local` (`EmailPasswordProvider`,
modeling legacy local as a first-class provider though the live login path no longer routes through it)
+ `google`. Microsoft/Apple/GitHub/Facebook = new class + one registry line.

### Google security specifics

- **Server-side verification only** — the frontend token is never trusted.
- **Claim checks (both modes):** issuer, audience, expiry, `email_verified === true`, nonce.
- **One-time nonce** (`nonceStore.js`): random, TTL-bounded, timing-safe membership, burned on consume,
  memory-capped (FIFO eviction) against `/nonce` spam.
- **Timing-safe HMAC** comparisons in `token.js` and the mock verifier.
- **No secret to the frontend** — `google/config` returns only the public client id.

---

## 12. Google Cloud Console Setup & Frontend Integration

### Cloud Console

1. Create/select a project at <https://console.cloud.google.com/>.
2. Configure the **OAuth consent screen** (External): app name, support email; scopes
   `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid`; add test users while in Testing.
3. **Credentials → Create OAuth client ID → Web application.**
4. **Authorized JavaScript origins:** `http://localhost:5173` (Vite dev) + your prod frontend origin.
5. **Authorized redirect URIs** (only for redirect flows / `GOOGLE_CALLBACK_URL`):
   `http://localhost:5000/api/auth/google/callback` + prod callback.
6. Copy the **Client ID** (+ secret) into the server `.env`:
   ```bash
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx
   ```
7. **`npm i google-auth-library`**, restart; `init()` logs `google mode=google`.

Mock → real switch: `mode = GOOGLE_CLIENT_ID ? "google" : "mock"` (`config/auth.config.js:googleMode()`).
If `GOOGLE_CLIENT_ID` is set but the library is missing → `503 CONFIG`.

### Frontend

`client/src/components/common/GoogleSignInButton.jsx` (injected into `AuthModal.jsx`): loads GIS,
fetches `getGoogleConfig()` + `getAuthNonce()`, initializes/renders the official Google button, and on
credential calls `googleLoginUser(credential, nonce)` → `POST /api/auth/google`. The client id is
fetched at runtime from `/api/auth/google/config` (single source of truth = server `GOOGLE_CLIENT_ID`);
the returned user is stored in `localStorage['rc_user']` exactly like the email/password path. Helpers
in `client/src/utils/api.js`: `getGoogleConfig()`, `getAuthNonce()`, `googleLoginUser(idToken, nonce)`.

---

## 13. Honest Limitations / Extension Points

- **JSON store, single-instance.** Users persist via the flat-file `utils/db.js`; **sessions** and
  the **audit trail** persist via file-backed `JsonStore` (`src/auth/data/sessions.json`,
  `auth_audit.json`), and the **nonce store** is a process-local in-memory `Map`. None are shared
  across instances and the nonce store does not survive restarts. For multi-instance deployments, back
  sessions/audit/nonce with **Redis or a database** behind the same interfaces.
- **Access token not enforced on legacy routes.** The existing booking/payment routes remain
  **tokenless** (RBAC middleware is *not* retrofitted onto them) so the current frontend keeps working.
  The middleware is ready for adoption when clients start sending the access token (§5).
- **Refresh reuse revokes the whole session.** Reuse detection is session-level: a replayed refresh
  `jti` revokes that session (a conservative choice — it does not attempt to distinguish attacker from
  a race).
- **argon2 / bcrypt are optional.** They are `optionalDependencies` (`argon2`, `bcryptjs`) plus
  `google-auth-library`; if the selected algorithm's package is not installed, hashing **falls back to
  scrypt** and Google real-mode returns `503 CONFIG`. Default runtime needs **zero** native deps.
- **`GOOGLE_CALLBACK_URL` / `GOOGLE_CLIENT_SECRET`** are wired into config but unused by the current
  ID-token verification path — reserved for a future redirect/code-exchange provider.
- **`EmailPasswordProvider` is not on the live login path.** It models `local` as a first-class
  provider for the abstraction; the production `POST /api/auth/login` route goes through
  `AuthService.authenticateLocal` (hashed + migrating), not this provider's plaintext mirror.
- **Pluggable providers** (Microsoft/Apple/GitHub/Facebook) are anticipated by the registry but not
  yet implemented.
