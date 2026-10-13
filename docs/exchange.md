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
| `/orders` | guest order tracking (id + token) and proof upload |

Client logic is in `site/assets/exchange.js`. The page only talks to the same
origin (`connect-src 'self'`), so no CORS is involved.

## Routes

All under `functions/exchange.mjs`, rewritten from `/api/exchange/*`:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/exchange/rates` | open flag, `thbToMmk`, `mmkToThb`, minimums, levels, channels |
| `POST` | `/api/exchange/calculate` | convert an amount (no persistence) |
| `POST` | `/api/exchange/orders` | create an order → `orderId`, `reference`, `viewToken` |
| `POST` | `/api/exchange/orders/list` | batch lookup by `{id, viewToken?}` (max 50) |
| `GET` | `/api/exchange/orders/:id` | detail; redacted unless `?token=` is correct |
| `POST` | `/api/exchange/orders/:id/proof` | upload proof, JSON `{token, mimeType, dataBase64}` |
| `GET` | `/api/exchange/orders/:id/proof?token=` | fetch proof bytes |

The token may also be sent as an `X-View-Token` header. `route()` dispatches on
`event.httpMethod` + `pathOf(event)` and the public function serves **only**
these; every other path is `404`.

## Order creation

`POST /api/exchange/orders`:

1. **Rate limit first** — 10 creates per IP per 10 minutes
   (`makeLimiter(10, 10 * 60 * 1000)`). Over the limit returns
   `429 {ok:true, discarded:true, error:"rate limited"}`. The counter is held
   in a module-level `Map` per **warm instance**, so across the fleet the
   effective limit is approximate (more requests than an instance saw can get
   through; fewer can be blocked). The invariant is unit-tested in
   `test/exchange.test.mjs`; a live burst of 16 post-limit attempts drew no
   `429` because Netlify spread them across instances.
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

- `publicOrder(order)` — id, reference, status, direction, amount,
  receiveAmount, rateUsed, method, level, fee, `hasProof`, timestamps, and
  `isRedacted: true`.
- `fullOrder(order)` — everything, including `senderName`, `senderContact`,
  `accountNo`, `accountName`, `note`, `proofFileName`, and `isRedacted: false`.

`viewOrder(order, token)` returns `fullOrder` **only** when the caller's token
equals `order.viewToken`; otherwise `publicOrder`. So:

- A guest can always learn that an order exists (its id, status, timestamps).
- The amounts, email and proof resolve **only** with the 48-hex token.
- The neighbour's obvious id must not leak your amounts.

The storefront `listOrders` stays redacted. The single deliberate exception is
the authenticated admin listing (`adminOrdersPage`), which maps every row
through `fullOrder` so the panel can show who sent it. See [`admin.md`](admin.md).

## Proof upload and fetch

`parseProofInput()` accepts `mimeType` ∈ `{image/jpeg, image/png, image/webp}`
and base64 data, **decoded before the cap is applied**: between 1 byte and 5 MB.
A bad or missing token returns `404 Order not found` (not `403`), so a probe
cannot confirm an order exists that way.

Fetch returns the raw bytes with the stored MIME type, `Cache-Control: no-store`
and `Content-Length`. The admin panel previews these via a `blob:` URL, which is
why the company CSP `img-src` includes `blob:` and `data:`.

## Blobs constraints the code is built around

See [`architecture.md`](architecture.md) for the full story; in short:

- **Append-only.** Orders, rate history and audit entries are new keys read by
  prefix listing. There is no `order:index` / `rate:history:index` /
  `audit:index`; those sentinels were removed and are filtered as inert if seen.
- **No strong consistency in v1.** Updates/deletes propagate within ~60 s, so
  the code never assumes read-after-write. `InMemoryStore` (tests) is strong by
  construction and will not reveal a violation.

## Validation and safety

`functions/exchange-lib/validate.mjs`:

- amounts: `Number.isFinite`, positive, bounded by `MAX_ORDER_AMOUNT = 10^9`
  (`JSON.parse("1e309")` yields `Infinity`);
- caps: name 120, contact 200, account no 64, account name 120, note 1000,
  method 64; post text 4000, post url 2000;
- `cleanText()` strips CRLF/control characters, trims and truncates;
- `assertSafeKeys()` rejects `__proto__` / `constructor` / `prototype` one level
  deep;
- bodies are parsed with a byte cap (`MAX_JSON_BODY_BYTES = 64 KB`, or 8 MB for
  proofs) and rejected if not a JSON object.

## Tests

Server: `test/exchange.test.mjs`. Client (VM fake DOM):
`test/exchange-client.test.mjs`. The server tests inject an `InMemoryStore`, so
no environment variable is needed. See [`testing.md`](testing.md).
