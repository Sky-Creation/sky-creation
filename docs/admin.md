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
with `saltHex` + `hashHex` (scrypt) and lockout bookkeeping. **The password is
never stored in plaintext and is never read from an environment variable at
runtime.** `EXCHANGE_ADMIN_PASSWORD` is only an input to the seed script.

Seed or reseed with:

```sh
node scripts/seed-admin.mjs --password <pw>
netlify blobs:set SCI_ADMIN user:primary --input seed-admin-out.json
```

See [`runbook.md`](runbook.md) for recovery.

## Routes

All under `functions/admin.mjs`, rewritten from `/api/admin/*`, plus the public
`/api/posts`.

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/admin/login` | `{identifier, password}` → access token + refresh cookie |
| `POST` | `/api/admin/logout` | deletes the refresh session, clears the cookie |
| `POST` | `/api/admin/refresh` | rotates the refresh session, returns a new access token |
| `GET` | `/api/admin/session` | who am I (requires a valid access token) |

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

### Legacy aliases

Pre-module paths kept working for older clients: `GET /api/admin/stats`,
`GET /api/admin/orders`, `GET /api/admin/orders/:id`,
`POST /api/admin/orders/:id/<action>`, and `GET|POST /api/admin/rates`.

## Authentication

Implemented in `functions/exchange-lib/auth.mjs`; configured by
`EXCHANGE_JWT_SECRET` (missing → `503 Admin auth is not configured`).

- **Access token** — HS256 JWT, 15 minutes, `{sub, role:'ADMIN'}`, sent as a
  `Bearer` token. `verifyAccessToken` rejects `alg:none` and forged signatures;
  a wrong role is `403`, any other token error is `401`.
- **Refresh cookie** — `httpOnly`, 7 days, `Path=/api/admin`, holding a session
  jti stored in `SCI_ADMIN` under `session:<id>`. `refresh` **rotates** it; a
  replayed old session is rejected (`401`), and sessions self-expire.
- **Wrong identifier vs wrong password** answer identically (`401`).
- **Lockout** — 5 failed logins freeze the account for 15 minutes (`403`,
  audited as `auth.locked`); the fifth failure's response *is* the lockout.
- **Rate limit** — 10 login attempts per IP per 10 minutes (`429`), held in
  memory like the order-create limiter: **per warm instance**, so across the
  fleet the effective limit is approximate (a live burst proved this: 16
  post-limit attempts on one IP, no `429`; the invariant is unit-tested).
- **Timing-safe compare** — `timingSafeEqual` throws on a length mismatch, so
  `auth.mjs` guards lengths first; an empty signature must throw `TokenError`,
  never a `RangeError`.

Login, logout, failed attempts and lockouts are all audited.

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
  `exchange.state`.
- `defaultRate` — stored at `setting:defaultRate`; the seed value `getRate()`
  uses when `rate:current` is unset (audited as `settings.defaultRate`).

## The redaction exception

`adminOrdersPage` maps every row through `fullOrder` — this is the one place the
full order (sender name/contact, destination account, note) is served without a
per-order token, and it is gated by `requireAdmin`. The storefront listing stays
`publicOrder`-redacted. Do not "unify" these; the asymmetry is the point. See
[`exchange.md`](exchange.md).

## Data stores

`SCI_ADMIN` (user, sessions, audit, posts, settings) plus the exchange stores
via the shared core. Treat `SCI_ADMIN` like the order store: deleting it loses
the panel account and the audit history, and the seed command is the recovery
path. The admin function's own header comment still names `SCI_PROOFS`; the
actual store opened by `store.mjs` is `SCI_EXCHANGE_PROOFS`.

## Same-origin by design

`/api/admin/*` is same-origin and `admin.html` uses no CORS. Do not add
`Access-Control-Allow-Origin` — a REST client does not need CORS, and a
same-origin password panel does not use it.

## Tests

Server: `test/admin.test.mjs` (seeded scrypt user; login, sessions, modules,
audit). Client: `test/admin-client.test.mjs` (VM fake DOM). The server tests
inject an `InMemoryStore`, so no environment variable is needed. See
[`testing.md`](testing.md).
