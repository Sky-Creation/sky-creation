# Architecture

Purpose: how a browser request reaches a Netlify Function and Netlify Blobs,
and where the important boundaries are.

Read this when: you need to know which file handles a route, where data lives,
or why the two-site layout behaves the way it does.

## One repository, two Netlify sites

| Site | Root | Publish dir | Netlify ID |
| --- | --- | --- | --- |
| Company — `skycreation.dev` | repo root | `site/` | `19485f7b-5cc0-426e-a8a0-4ad43a5ea66a` |
| Founder — `founder.skycreation.dev` | `site/founder/` | `site/founder/` | `b851f1db-a2f0-4f67-81aa-6798f5296ab6` |

Both are deployed by the same workflow (see [`ci-cd.md`](ci-cd.md)). The founder
site is a plain static page; the company site carries the Functions.

## The static layer

`site/` is hand-written HTML/CSS/JS. There is no build step and no framework.
Netlify's `pretty_urls` means `/about` and `/about.html` both serve; **only the
extensionless form is canonical** and may appear in links, canonicals and
`og:url`.

Pages:

| Page | File |
| --- | --- |
| Landing | `site/index.html` |
| About | `site/about.html` |
| Work | `site/work.html` |
| Maths | `site/math.html` |
| Contact | `site/contact.html` |
| Exchange | `site/exchange.html` |
| Orders (tracking/proof) | `site/orders.html` |
| Admin panel | `site/admin.html` (noindex, not in the sitemap) |
| 404 | `site/404.html` |

Client scripts live in `site/assets/` (`main.js`, `exchange.js`, `admin.js`,
`posts.js`; plus `styles.css` and the favicons). All are plain scripts; the
exchange and admin pages talk to the same origin only, which keeps the CSP
`connect-src 'self'` intact.

## The Functions layer

`functions/` is at the **repository root**, not under `site/`, on purpose: with
`publish = "site"` anything under `site/` is uploaded and served as a static
file. Moving the functions under `site/` once published the honeypot field name
and the rate-limit numbers. See `AGENTS.md` §4.

```
functions/
  contact.mjs              contact form -> Brevo
  exchange.mjs             PUBLIC /api/exchange/* only
  admin.mjs                ALL /api/admin/* + public /api/posts
  exchange-lib/
    orders.mjs             createOrderStore: the shared domain core
    store.mjs              JsonStore / InMemoryStore blobs wrapper + openStores
    validate.mjs           input validation and sanitisation
    http.mjs               response helpers, clientIp, pathOf
    auth.mjs               scrypt hashing, HMAC JWTs, refresh sessions
```

`exchange.mjs` and `admin.mjs` are same-origin functions that share one core:
both build a store with `createOrderStore({ store, proofs, auditStore, env })`
from `orders.mjs`, so the storefront and the admin panel can never disagree
about quoting, redaction or persistence. `admin.mjs` additionally opens the
`SCI_ADMIN` store for the user row, sessions, posts, settings and the unified
audit log.

## Request flow

```
browser
  │  GET /  or  /about                 -> static file from site/
  │  GET /api/posts                   -> redirect -> /.netlify/functions/admin
  │  POST /api/contact                -> redirect -> /.netlify/functions/contact
  │  /api/exchange/*                  -> redirect -> /.netlify/functions/exchange
  │  /api/admin/*                     -> redirect -> /.netlify/functions/admin
  ▼
Netlify edge
  • applies [[redirects]] and [[headers]] from netlify.toml
  • pretty URLs, CSP and security headers on every response
  ▼
Netlify Function (v1 Lambda-style, exported `handler`)
  • route() dispatches on the path; every handler is awaited
  • on throw of httpError(status, message), the dispatcher returns fail(status, message)
  ▼
Netlify Blobs
  • SCI_EXCHANGE_ORDERS, SCI_EXCHANGE_PROOFS, SCI_ADMIN
```

The rewrites are declared in `netlify.toml`. Routing inside a function uses
`event.path`, with a static `__exchange_path` query fallback for the case where
the path is already resolved. With a query string the view token is read from
`queryStringParameters`, not the path.

Because both API trees are rewritten to same-origin function URLs, the page
JavaScript uses no CORS. Do not "fix" the API to send
`Access-Control-Allow-Origin`; a same-origin panel does not use it.

## The data layer

Three Blob stores, each a separate failure domain:

| Store | Holds | Key shapes |
| --- | --- | --- |
| `SCI_EXCHANGE_ORDERS` | orders, current rate, open flag, rate history | `order:<id>`, `rate:current`, `rate:history:<ts>:<rand>`, `setting:open`, `setting:defaultRate`, `setting:channels` |
| `SCI_EXCHANGE_PROOFS` | uploaded proof images | `proof:<orderId>` |
| `SCI_ADMIN` | admin user, refresh sessions, audit log, posts, settings | `user:primary`, `session:<id>`, `audit:<ts>:<rand>`, `post:company:*`, `post:math:*`, `setting:*` |

Reads and writes go through the `JsonStore` wrapper in `store.mjs`, never the raw
`@netlify/blobs` `Store`. The wrapper normalises two behaviours the raw store
has that broke production once:

- `get()` returns **parsed JSON** (`{ type: 'json' }` under the hood), not text.
- `list()` returns a plain array, not `{ blobs, directories }`.
- `set(key, object)` stores JSON text; `set(key, buffer)` stores raw bytes.

`openStores(event)` also calls `connectLambda(event)` for v1 handlers, and
throws on the dangerous keys `__proto__` / `constructor` / `prototype`.

### Eventual consistency

Netlify Blobs are **eventually consistent**, and v1 cannot opt out: strong
consistency is unavailable because the SDK routes strong reads through an
`uncachedEdgeURL` that `connectLambda` never receives. The app adapts rather
than fights it:

- Orders, rate history and audit entries are **append-only**: written under new
  keys and read by prefix listing. There is no read-modify-write index.
- Admin state transitions re-read once after 250 ms before reporting a state
  conflict (`transition()` in `orders.mjs`).
- New keys are readable immediately; updates and deletes propagate within ~60 s.

The in-memory test store is strong by construction, so tests never exercise the
consistency window. See [`exchange.md`](exchange.md) and [`testing.md`](testing.md).

## Security model at a glance

- **Contact form**: honeypot field `company` (hidden), per-IP rate limit, body
  and field caps. A success response is only returned when a send was attempted.
- **Exchange storefront**: order details are redacted unless the caller holds
  the per-order 48-hex `viewToken`. A guest can always see that an order exists
  (id, status, timestamps) but not the amounts, email or proof. The one
  deliberate exception is the authenticated admin listing, which uses
  `fullOrder`.
- **Admin**: scrypt-hashed password (seeded `user:primary` row), 15-minute HMAC
  access token, httpOnly refresh cookie rotated on use, 5-failure/15-minute
  lockout, `alg:none` and forged signatures rejected.
- **Headers/CSP** (company site, `netlify.toml`): `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, HSTS, a `default-src 'self'` CSP, and
  `img-src` that includes `blob:` (proof previews) and `data:`. HTML revalidates
  on every load; `assets/*` caches for an hour.

## Boundaries that must not move

These are the load-bearing choices; the reasoning is in [`decisions.md`](decisions.md)
and `AGENTS.md` §4.

- `test/` and `functions/` stay at the repo root.
- The public and admin functions stay split, sharing `orders.mjs`.
- Blob access stays behind `JsonStore`.
- Append-only keys, no read-modify-write indexes.
- Extensionless URLs are canonical.
- No build step and no new dependencies without asking.
