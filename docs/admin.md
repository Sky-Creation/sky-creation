# Admin panel

Purpose: the same-origin, password-protected panel for the exchange orders and
rates, the Facebook post lists, site settings and the audit log.

Read this when: you are changing `functions/admin.mjs`, `site/admin.html`,
`site/assets/admin.js`, `scripts/seed-admin.mjs` or `exchange-lib/auth.mjs`.

The panel is site-wide, not exchange-only. The public exchange storefront is a
separate function — see [`exchange.md`](exchange.md). Both call the shared
`createOrderStore()` core, so they agree on quoting, redaction and persistence.

## Pages and account

- `/admin` — panel (noindex, disallowed in `robots.txt`, not in the sitemap).
- Login is a seeded **username or email** plus a password. There is one role,
  `ADMIN`; the seeded row id is `primary`.

The account lives in the `SCI_ADMIN` blob store under `user:primary` as a row
with `saltHex` + `hashHex` (scrypt) and `authVersion`. **The password is
never stored in plaintext and is never read from an environment variable at
runtime.** `EXCHANGE_ADMIN_PASSWORD` is only an input to the seed script.

Seed or reseed with:

```sh
node scripts/seed-admin.mjs --password <pw>
netlify blobs:set SCI_ADMIN user:primary --input seed-admin-out.json
```

After a reseed, delete existing `session:*` keys (or bump `authVersion`) so old
refresh cookies stop minting access tokens. See [`runbook.md`](runbook.md).

## Routes

All under `functions/admin.mjs`, rewritten from `/api/admin/*`, plus the public
`/api/posts`.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/admin/login` | `{identifier, password}` → access token + refresh cookie |
| `POST` | `/api/admin/logout` | deletes the refresh session, clears the cookie |
| `POST` | `/api/admin/refresh` | rotates the refresh session, returns a new access token |
| `GET` | `/api/admin/session` | who am I (requires a valid access token + matching `authVersion`) |

### Modules

| Method | Path | Module |
| --- | --- | --- |
| `GET` | `/api/admin/dashboard` | stats, rate, recent rate history, recent audit, post counts |
| `GET` | `/api/admin/exchange/stats` | exchange counts/volume |
| `GET` | `/api/admin/exchange/orders?status&q&page&perPage` | order list (paged, max 50/page, newest first) |
| `GET` | `/api/admin/exchange/orders/:id` | one full order **including** `viewToken` |
| `POST` | `/api/admin/exchange/orders/:id/approve\|reject\|complete\|delete` | transitions |
| `GET`/`POST` | `/api/admin/exchange/rates` | read / apply rate + open |
| `GET` | `/api/admin/audit?page` | unified audit log (25/page) |
| `GET` | `/api/admin/posts` | both post lists |
| `POST` | `/api/admin/posts/:list` | create (`:list` ∈ `{company, math}`) |
| `PUT` | `/api/admin/posts/:list/:id` | update |
| `DELETE` | `/api/admin/posts/:list/:id` | delete |
| `GET`/`POST` | `/api/admin/settings` | `{open, defaultRate}` |
| `PATCH` | `/api/admin/account` | change username/email/name/password |
| `GET` | `/api/posts` | **public**, both lists (no auth) |

Authenticated module handlers use `requireUser` (JWT + `authVersion` match),
not bare signature checks.

### Legacy aliases

Pre-module paths kept working for older clients: `GET /api/admin/stats`,
`GET /api/admin/orders`, `GET /api/admin/orders/:id`,
`POST /api/admin/orders/:id/<action>`, and `GET|POST /api/admin/rates`.

## Authentication

Implemented in `functions/exchange-lib/auth.mjs`; configured by
`EXCHANGE_JWT_SECRET` (missing → `503 Admin auth is not configured`).

- **Access token** — HS256 JWT, 15 minutes, `{sub, role:'ADMIN', authVersion}`,
  held **in memory** by the panel (never localStorage). Sent as `Bearer`.
  `verifyAccessToken` rejects `alg:none` and forged signatures; a wrong role is
  `403`, any other token error is `401`. A mismatched `authVersion` is `401`.
- **Refresh cookie** — `httpOnly`, 7 days, `Path=/api/admin`, holding a session
  jti stored in `SCI_ADMIN` under `session:<id>` with the same `authVersion`.
  `refresh` **rotates** it; a replayed old session is rejected (`401`), and
  sessions self-expire. Page load boots via `POST /api/admin/refresh`.
- **Wrong identifier vs wrong password** answer identically (`401`).
- **No account lockout.** Per-IP login limit is **5 / 15 minutes** via shared
  Upstash (`admin-login` namespace) → `429` + `Retry-After`. A third party
  cannot freeze the only administrator out globally.
- **Password change** bumps `authVersion`, deletes all refresh sessions, clears
  the cookie and returns `{ signedOut: true }`.
- **Timing-safe compare** — `timingSafeEqual` throws on a length mismatch, so
  `auth.mjs` guards lengths first; an empty signature must throw `TokenError`,
  never a `RangeError`.

Login, logout and failed attempts are audited (`admin.login`,
`admin.login.failed`, `admin.logout`). Identifier and IP are stored as HMAC
hashes, not plaintext.

## Posts

Post lists are keyed `post:company:*` and `post:math:*` in `SCI_ADMIN`, with ids
of the form `<base36 time>:<hex>`. Each post is `{date, text, url}` validated by
`parsePostInput()`: `date` a real `YYYY-MM-DD`, `text` 1..4000 chars, `url`
optional and `http(s)`. Listing sorts by date descending.

Both lists start **empty**. A page section with no posts hides itself. The site
reads `/api/posts` (public) and falls back to the static
`site/assets/posts.js` only when that response is missing or unparseable — a
working API is authoritative.

## Settings

- `open` — toggles the exchange; applied through `ratesApply()` so it audits as
  `exchange.state`. The rates form may POST `{ open }` alone (empty rate field).
- `defaultRate` — stored at `setting:defaultRate`; the seed value `getRate()`
  uses when `rate:current` is unset (audited as `settings.defaultRate`).
  Valid band 50–500.

## The redaction exception

`adminOrdersPage` maps every row through `fullOrder` — this is the one place the
full order (sender name/contact, destination account, note) is served without a
per-order token, and it is gated by `requireUser`. The storefront listing stays
`publicOrder`-redacted. Do not "unify" these; the asymmetry is the point. See
[`exchange.md`](exchange.md).

## Data stores

`SCI_ADMIN` (user, sessions, audit, posts, settings) plus the exchange stores
via the shared core. Treat `SCI_ADMIN` like the order store: deleting it loses
the panel account and the audit history, and the seed command is the recovery
path.

## Same-origin by design

`/api/admin/*` is same-origin and `admin.html` uses no CORS. Do not add
`Access-Control-Allow-Origin` — a REST client does not need CORS, and a
same-origin password panel does not use it.

## Environment

| Variable | Role |
| --- | --- |
| `EXCHANGE_JWT_SECRET` | **required** for access/refresh tokens |
| `RATE_LIMIT_HMAC_KEY` | **required** in production (≥ 32 chars) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **required** in production |
| `SKY_EXCHANGE_TEST=1` | in-memory stores + memory limiter (tests only) |

## Tests

Server: `test/admin.test.mjs` (seeded scrypt user; login, sessions, modules,
audit). Client: `test/admin-client.test.mjs` (VM fake DOM; boots via refresh).
