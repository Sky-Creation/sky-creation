# Testing

Purpose: what the two test suites cover, how to run them, and the constraints
that keep them runnable without installing anything.

Read this when: you are adding or changing a function, the exchange, the admin
panel, the contact form, the DNS parsers or the seed script.

## Commands (exactly what CI runs)

```sh
# Node — 113 tests
node --test test/*.test.mjs

# Python — 48 tests
python -m unittest discover -s infra
```

- No environment variable is required. The suites construct the functions with
  `createServer({ store: new InMemoryStore(), ... })`, so no test touches the
  real Blob stores. `SKY_EXCHANGE_TEST=1` is the switch that makes
  `openStores()` (the real `handler` path) return in-memory stores; use it only
  when exercising a handler end to end. `deploy.yml` runs the suite with no
  variables set, which is the proof.
- The glob `test/*.test.mjs` is required. `node --test test/` is invalid — Node
  treats the directory as a module name and dies with `MODULE_NOT_FOUND`.
- **No `npm install` is needed.** CI never installs `@netlify/blobs`; the
  functions import it lazily so importing a function under test never pulls it in.

## The Node suite (`test/`)

| File | Scope | Approx. |
| --- | --- | --- |
| `main.test.mjs` | Contact form and posts rendering, client side | 14 |
| `contact.test.mjs` | Contact form, server side | 14 |
| `exchange.test.mjs` | Exchange storefront, server side | 26 |
| `exchange-client.test.mjs` | Exchange storefront, client side (VM fake DOM) | 10 |
| `admin.test.mjs` | Admin function, server side (seeded scrypt user; login/sessions/modules/audit) | 32 |
| `admin-client.test.mjs` | Admin panel, client side (VM fake DOM) | 14 |
| `seed.test.mjs` | `scripts/seed-admin.mjs` | 3 |

### Server-side tests

They build the server with `createServer` / `createAdminServer` and pass in an
`InMemoryStore` for each store, then call `route()` with a synthetic Netlify
event and assert on the returned response. A seeded scrypt user row is written
into the in-memory `SCI_ADMIN` store for the admin tests.

The server tests cover, among other things: the redaction contract (a guest
cannot read amounts/email/proof without the token; the authenticated admin
listing can), the order lifecycle and its illegal transitions, rate updates and
history, the contact-form send/no-send invariants, and the audit log.

### Client-side tests

The page scripts (`assets/exchange.js`, `assets/admin.js`, `assets/main.js`)
are loaded into a Node `vm` context with a hand-written fake DOM and `fetch`
stub. This exercises the client logic — including the rule that "converted" or
"ordered" is never shown without a server answer — with no browser and no
dependency.

## The Python suite (`infra/`)

`infra/test_dns_doctor.py` covers the DNS record parsers:

- DKIM detection without a required `v=DKIM1` tag (Brevo omits it), including
  the revoked-key (`p=`) case.
- Following the two-hop CNAME chain to the name that actually holds the key.
- Zone routing: in-zone names to the authoritative servers, out-of-zone names to
  a recursive resolver.
- Only definitive answers are cached — a timed-out server (dig exit 9) must be
  re-probed, not cached as "record missing".
- Brevo verification records, SPF parsing/lookup counting, DMARC policy.

These parsers were wrong for a long time precisely because nothing ran; keep
the tests up when you touch `dns_doctor.py`. See [`dns.md`](dns.md).

## Invariants the tests exist to protect

If you change behaviour, these are the assertions you must keep true:

1. **A fast contact submission must send.** There is no timing gate, and the
   honeypot is the *only* success-without-sending path.
2. **Same rule for the exchange**: "converted"/"ordered" only after a server
   answer; the `company` honeypot is the only success-without-persistence path.
3. **Redaction**: storefront `listOrders` is always status-only `publicOrder`;
   detail lifts only with the `X-View-Token` header; only `adminOrdersPage`
   maps through `fullOrder`.
4. **Tokens**: `alg:none` and forged signatures are rejected; an empty signature
   must throw `TokenError`, never a `RangeError` (the length guard in `auth.mjs`
   exists because `timingSafeEqual` throws on a length mismatch). Access JWTs
   carry `authVersion`; password change invalidates them.
5. **Validation**: non-finite amounts, oversized fields, control characters and
   prototype-pollution keys are all rejected (`validate.mjs`).
6. **Rate limits**: 429 responses are `{ error }` with `Retry-After`; tests use
   the memory limiter (`SKY_EXCHANGE_TEST=1` or an injected limiter), never
   live Upstash.

## Adding a test

- Put server tests beside the existing ones in the matching `*.test.mjs`, or add
  a new file; the glob picks it up automatically.
- Keep everything runnable without `npm install`. If your test touches a path
  that would hit the network or the real store, inject an `InMemoryStore` (or
  guard it behind `SKY_EXCHANGE_TEST=1`). Upstash packages are production-only
  dynamic imports.
- Test the invariants above, not the implementation. The suites were written
  with the real bugs live; that is why they are specific.

## A caution about the in-memory store

`InMemoryStore` is **strongly consistent by construction**, while the real v1
Blobs store is eventually consistent. No Node test can see the consistency
window. Anything that depends on read-after-write ordering must be handled in
the code (append-only keys, the 250 ms re-read in `transition()`), not asserted
in a test. See [`exchange.md`](exchange.md).
