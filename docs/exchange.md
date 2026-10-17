# SCI Exchange (storefront)

Purpose: the public THB↔MMK conversion and order API — its routes, data model,
redaction rules and the Blobs constraints the code is built around.

Read this when: you are changing `functions/exchange.mjs`,
`functions/exchange-lib/`, `site/exchange.html`, `site/orders.html` or
`site/assets/exchange.js`.

The admin side of the same data lives in [`admin.md`](admin.md). Both surfaces
share one core: `createOrderStore()` in `functions/exchange-lib/orders.mjs`.

## Pages and scripts

| Page | Purpose |
| --- | --- |
| `/exchange` | converter + "start an order" form |
| `/orders` | guest order tracking (id + `#token=`) and proof upload |

Client logic is in `site/assets/exchange.js`. The page only talks to the same
origin (`connect-src 'self'`), so no CORS is involved. Tracking links keep the
view token in the URL fragment (`#token=`); the client sends it as
`X-View-Token` and migrates a legacy `?token=` query into the fragment.

## Routes

All under `functions/exchange.mjs`, rewritten from `/api/exchange/*`:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/exchange/rates` | open flag, `thbToMmk`, `mmkToThb`, minimums, levels, channels |
| `POST` | `/api/exchange/calculate` | convert an amount (no persistence) |
| `POST` | `/api/exchange/orders` | create an order → `orderId`, `reference`, `viewToken` |
| `POST` | `/api/exchange/orders/list` | batch lookup by `{id}` only (max 50); always status-only |
| `GET` | `/api/exchange/orders/:id` | detail; full only with `X-View-Token` |
| `POST` | `/api/exchange/orders/:id/proof` | upload proof (header token + JSON image body); `PENDING` only |
| `GET` | `/api/exchange/orders/:id/proof` | fetch proof bytes (`X-View-Token`) |

Query-string and body tokens are **ignored**. `route()` dispatches on
`event.httpMethod` + `pathOf(event)` and the public function serves **only**
these; every other path is `404`.

## Order creation

`POST /api/exchange/orders`:

1. **Rate limit first** — 10 creates per IP per 10 minutes via the shared
   Upstash limiter (`exchange-lib/rate-limit.mjs`, namespace
   `exchange-order-create`). Over the limit returns
   `429 { error: "Too many requests. Try again later." }` with `Retry-After`.
   IPs are HMAC-hashed with `RATE_LIMIT_HMAC_KEY` before they hit Redis.
   Missing Upstash/`RATE_LIMIT_HMAC_KEY` configuration fails closed (`503`).
2. **Honeypot** — a non-empty `company` field logs
   `exchange: honeypot triggered, order discarded` and returns
   `{ok:true, discarded:true}` **persisting nothing**. This is the only
   success-without-persistence path, mirroring the contact form. The discard is
   logged deliberately.
3. **Open check** — a closed exchange returns `503`.
4. **Validation** via `parseOrderInput()`: `direction` ∈
   `{THB_TO_MMK, MMK_TO_THB}`, a finite positive `amount` ≤ `10^9`, a valid
   `level` ∈ `{Standard, Express, VIP}`, a non-empty `method`, and
   `senderName` + `senderContact`.
5. **Minimum** — `MINIMUMS = { THB: 100, MMK: 10000 }`.
6. **Quote** at the current rate, then persist.

The stored order carries a `viewToken` (`randomBytes(24).toString('hex')`, 48
hex chars), the client IP and a truncated user-agent. The create response is the
**only** time the `viewToken` is returned.

## Data model

Orders live in `SCI_EXCHANGE_ORDERS` under `order:<id>`. Key fields: `id`,
`reference`, `status`, `direction`, `amount`, `receiveAmount`, `rateUsed`,
`fee`, `method`, `level`, `senderName`, `senderContact`, `accountNo`,
`accountName`, `note`, `viewToken`, `ip`, `userAgent`, `createdAt`, `updatedAt`,
`completedAt`, `proofAt`, `proofFileName`.

Order ids: `ord-<base36 time><8 hex>`. References: `SC-<base36 time><4 hex>`.

Rate state: `rate:current` (`thbToMmk`, `mmkToThb`, `updatedAt`, `source`),
history under `rate:history:<ts>:<rand>`, open flag at `setting:open`, an
optional admin seed at `setting:defaultRate`, and channels at
`setting:channels`. Proof binaries are in `SCI_EXCHANGE_PROOFS` under
`proof:<orderId>`, with metadata at `proof:meta:<orderId>` (in the orders store).

Valid THB→MMK rates are in the band **50–500**.

### Effective rate resolution

`getRate()` uses, in order:

1. `rate:current` if it is a positive finite number;
2. `setting:defaultRate` (an admin-configured seed);
3. `EXCHANGE_RATE_DEFAULT` env var;
4. the built-in `DEFAULT_RATE = 128.5`.

If none of 1 is set, the seed is written to `rate:current` and appended to
history as `source: 'seed'`.

## Redaction — the important rule

Two projections in `orders.mjs`:

- `publicOrder(order)` — id, reference, status, timestamps (`createdAt`,
  `updatedAt`, `completedAt`), and `isRedacted: true`. No amounts, direction,
  method, fee or `hasProof`.
- `fullOrder(order)` — commercial + PII fields, `hasProof`, `proofFileName`,
  and `isRedacted: false`.

`viewOrder(order, token)` returns `fullOrder` **only** when the caller's
`X-View-Token` equals `order.viewToken`; otherwise `publicOrder`. So:

- A guest can always learn that an order exists (its id, status, timestamps).
- The amounts, parties and proof resolve **only** with the 48-hex header token.
- The neighbour's obvious id must not leak your amounts.
- The storefront `listOrders` route **never** accepts tokens — every card stays
  status-only.

The single deliberate exception is the authenticated admin listing
(`adminOrdersPage`), which maps every row through `fullOrder`. See
[`admin.md`](admin.md).

## Proof upload and fetch

`parseProofInput()` accepts `mimeType` ∈ `{image/jpeg, image/png, image/webp}`
and base64 data, **decoded before the cap is applied**: between 1 byte and 5 MB.
Token and status are checked **before** parsing: a bad or missing
`X-View-Token` returns `404 Order not found` (not `403`); upload is refused
unless the order is still `PENDING`.

Fetch returns the raw bytes with the stored MIME type, `Cache-Control: no-store`
and `Content-Length`. The admin panel previews these via a `blob:` URL, which is
why the company CSP `img-src` includes `blob:` and `data:`.

## Blobs constraints the code is built around

See [`architecture.md`](architecture.md). Short version: Blobs is eventually
consistent in the v1 Lambda environment; orders and history are append-only;
admin transitions re-read once after 250 ms before reporting a state conflict.

## Environment

| Variable | Role |
| --- | --- |
| `EXCHANGE_RATE_DEFAULT` | optional seed THB→MMK rate |
| `RATE_LIMIT_HMAC_KEY` | **required** in production (≥ 32 chars) |
| `UPSTASH_REDIS_REST_URL` | **required** in production |
| `UPSTASH_REDIS_REST_TOKEN` | **required** in production |
| `SKY_EXCHANGE_TEST=1` | in-memory stores + memory limiter (tests only) |

## Tests

`test/exchange.test.mjs` (server) and `test/exchange-client.test.mjs` (VM fake
DOM). Tests inject memory limiters and never need Upstash installed for CI.
