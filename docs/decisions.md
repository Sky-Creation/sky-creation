# Decisions

Purpose: short records of the choices a future maintainer is most likely to
reconsider, with the reason and the alternative that was rejected.

Read this when: something looks odd and you are about to change it. If you
disagree with a decision, read the history first — several of these replaced a
reasonable-sounding idea that turned out to fail in production.

Format: **Decision / Why / Rejected / Source.**

---

## No build step, no framework, one dependency

- **Decision:** hand-written HTML/CSS/ES5-ish JS; the only root dependency is
  `@netlify/blobs`, and only the exchange function imports it.
- **Why:** free-tier hosting, nothing to compile, nothing to keep patched. The
  `package.json` exists for that one import, not as an invitation to add tooling.
- **Rejected:** a static-site generator or SPA framework.
- **Source:** `AGENTS.md` §1; `README.md`.

## `test/` and `functions/` live at the repo root

- **Decision:** keep them outside `site/`.
- **Why:** `publish = "site"` uploads *everything* under `site/` as static
  files. The contact function and the tests were served this way once, exposing
  the honeypot field name (`company`), the rate-limit numbers and the Brevo
  wiring — and honeypot detection only works while the field name is secret.
- **Rejected:** relying on the deny rules instead of the layout. The rules exist
  as belt-and-suspenders, not as the primary defence.
- **Source:** commit `8acd427`; `AGENTS.md` §4.

## Never show "sent" / "converted" without a send

- **Decision:** no timing gate, client or server. The honeypot is the only
  success-without-send path.
- **Why:** the "minimum fill time" gate showed "Message sent" without calling
  the API for pages younger than ~1.2 s, silently losing real enquiries from
  autofill and password managers. It never stopped bots because it trusted a
  caller-supplied timestamp.
- **Rejected:** any fill-time / "too fast" heuristic. Bots see the same pages.
- **Source:** commit `9f45f61`; `AGENTS.md` §4; [`contact.md`](contact.md).

## Extensionless URLs are canonical

- **Decision:** link to `/about`, never `/about.html`; set the canonical and
  `og:url` to the extensionless form.
- **Why:** Netlify `pretty_urls` serves both, but the `.html` form was being
  advertised to search engines and social cards.
- **Rejected:** treating both as equally canonical.
- **Source:** `AGENTS.md` §4.

## Public and admin are two same-origin functions sharing a core

- **Decision:** `exchange.mjs` serves only `/api/exchange/*`; `admin.mjs` owns
  all `/api/admin/*` and the public `/api/posts`; both call `createOrderStore()`
  from `exchange-lib/orders.mjs`.
- **Why:** a compromised public endpoint can never touch admin auth code in the
  same module, while the two surfaces still cannot disagree about quoting,
  redaction or persistence.
- **Rejected:** one function for everything; or two functions with duplicated
  order logic.
- **Source:** commit `e84962f`; [`architecture.md`](architecture.md).

## Blobs access goes through `JsonStore`, and the app is append-only

- **Decision:** never touch the raw `@netlify/blobs` `Store`; write new keys and
  read by prefix listing rather than maintaining indexes.
- **Why:** two live bugs were invisible to the in-memory tests. `get()` returns
  JSON *text* unless given `{ type: 'json' }`, so every order read as a string
  and redaction never lifted. And updates/deletes are eventually consistent
  (≤60 s), so a read-modify-write index loses concurrent writes.
- **Rejected:** using the raw store; requiring strong consistency. Strong
  consistency is **unavailable** in the v1 runtime — the SDK routes strong reads
  through an `uncachedEdgeURL` that `connectLambda(event)` never receives.
- **Source:** commits `f50efc6`, `cb8c33d`, `faa8d56`; [`architecture.md`](architecture.md).

## `connectLambda(event)` for v1 handlers

- **Decision:** call `connectLambda` when the event carries a `blobs` payload.
- **Why:** v1 Lambda-style handlers do not get the Blobs environment injected;
  without it the first store open dies with `getEnvironmentContext2 is not a
  function`.
- **Rejected:** assuming v2-injected runtime globals.
- **Source:** commit `25f9ac2`; `exchange-lib/store.mjs`.

## Order redaction, with one admin exception

- **Decision:** storefront listings and detail are `publicOrder` unless the
  caller holds the 48-hex `viewToken`; the authenticated admin listing maps every
  row through `fullOrder`.
- **Why:** the neighbour's obvious order id must not expose your amounts, email
  or proof — but the panel exists precisely to show who sent what.
- **Rejected:** a single projection; or redacting the admin list too.
- **Source:** [`exchange.md`](exchange.md), [`admin.md`](admin.md).

## Admin auth: scrypt + short HMAC token + rotating refresh cookie

- **Decision:** scrypt-hashed password seeded as `user:primary`; 15-minute HS256
  access token; 7-day rotating httpOnly refresh cookie; 5-failure/15-minute
  lockout; identical response for wrong identifier and wrong password.
- **Why:** matches the `sci-exchange` model the app was ported from, and keeps
  the free tier (no external auth service).
- **Rejected:** a plaintext or env-var password compared at runtime; long-lived
  access tokens.
- **Source:** `exchange-lib/auth.mjs`, `functions/admin.mjs`; [`admin.md`](admin.md).

## No CORS on the admin API

- **Decision:** `/api/admin/*` is same-origin; do not send
  `Access-Control-Allow-Origin`.
- **Why:** a same-origin password panel does not use CORS, and a REST client
  (curl/Postman) does not need it. Adding it would only widen the surface.
- **Rejected:** "fixing" the API to add CORS headers.
- **Source:** `AGENTS.md` §4.

## Auto-deploy on push, no Netlify UI link

- **Decision:** GitHub Actions deploys both sites with an auth token and
  explicit site IDs.
- **Why:** keeps the pipeline in the repo and avoids the double-deploy that
  linking the repo in the Netlify UI would cause.
- **Rejected:** Netlify's "Import an existing project" flow.
- **Source:** `deploy.yml`; [`deploy.md`](deploy.md), [`ci-cd.md`](ci-cd.md).

## `--dir` overrides `publish`; founder deploys from inside its directory

- **Decision:** `netlify deploy --dir=site` for the company; run the founder
  deploy from inside `site/founder/` with `--site`.
- **Why:** `--dir` overrides `[build] publish`, so pointing it at the repo root
  uploads the whole tree and 404s `/` (it has happened). Config selection comes
  from the working directory, so running the founder deploy from the root would
  bundle `functions/` onto the founder project and apply the `/founder` 301s to
  the founder site itself.
- **Rejected:** `--config site/founder/netlify.toml`. **netlify-cli has no
  `--config` flag** (27.10.2 rejects it); the doc claimed it for a while and it
  never worked.
- **Source:** `AGENTS.md` §4; [`deploy.md`](deploy.md).

## Founder keeps its own Netlify site; the Pages custom domain stays cleared

- **Decision:** `founder.skycreation.dev` is a separate Netlify site fed by a
  `founder` CNAME; `waiyantunoo.github.io` must **not** have
  `founder.skycreation.dev` as a GitHub Pages custom domain.
- **Why:** setting the Pages custom domain hijacks every `github.io/*` path
  (including the maths visualiser project sites) and 404s them.
- **Rejected:** hosting the founder site on GitHub Pages.
- **Source:** commits `99f4713`, `18c7e49`; `AGENTS.md` §6.

## DNS: zone routing, definitive-only caching, and the two-hop DKIM chain

- **Decision:** query in-zone names against the authoritative servers and
  out-of-zone names against a recursive resolver; cache only definitive answers;
  follow the full CNAME chain for DKIM.
- **Why:** Spaceship is authoritative only for `skycreation.dev`; asked about
  the `brevo.com` end of Brevo's DKIM chain it returns nothing, which reads as
  "missing". And caching a dig timeout (exit 9) as an empty record made every
  later query settle on "missing".
- **Rejected:** asking one server about every name; stopping at the first CNAME.
- **Source:** commits `bd255da`, `e9674c8`; [`dns.md`](dns.md).

## DNS watch files one tracking issue

- **Decision:** on failure, open a single issue (or comment on the open one);
  close it when DNS recovers.
- **Why:** a red nightly run nobody reads is the same as no monitoring. A new
  issue every night would spam the tracker.
- **Rejected:** relying on the Actions tab only.
- **Source:** `dns-watch.yml`; [`dns.md`](dns.md).

## `BREVO_API_KEY` is intentionally not marked secret

- **Decision:** store it as a plain Netlify env var.
- **Why:** on the free plan a secret cannot run in the `post_processing` scope,
  and restricting it to `functions` requires Pro — together there is no way to
  store a real secret. It is still server-side and never bundled into the site.
- **Rejected:** marking it secret (breaks the free plan) or moving it client-side
  (exposes it).
- **Source:** `AGENTS.md` §5; [`secrets.md`](secrets.md).

## Passwords are seeded, not stored in an environment variable

- **Decision:** `EXCHANGE_ADMIN_PASSWORD` is only input to
  `scripts/seed-admin.mjs`; the runtime reads the scrypt hash from `SCI_ADMIN`.
- **Why:** the runtime should never hold the plaintext, and the row can be
  rotated without redeploying.
- **Rejected:** comparing against `EXCHANGE_ADMIN_PASSWORD` at request time.
- **Source:** `scripts/seed-admin.mjs`; `AGENTS.md` §5.
