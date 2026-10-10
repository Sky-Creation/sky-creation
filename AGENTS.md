# AGENTS.md

Working notes for any AI agent or tool picking up this repository. Written by
opencode during the original build so a different model can continue without
rediscovering the same faults.

Human-facing documentation lives in [README.md](README.md). This file is the
operational one: what the traps are and what not to undo.

---

## 1. What this is

- **Production site:** <https://skycreation.dev> — six static pages plus one
  Netlify Function, no build step
- **Founder portfolio:** <https://founder.skycreation.dev> — source in
  `site/founder/`, separate Netlify site (same repo). Linked from the main menu
  as an external subdomain. Formerly hosted on GitHub Pages
  (`waiyantunoo.github.io`); keep that Pages site only as a redirect after DNS
  points `founder` at Netlify.
- **Hosting:** Netlify (free tier, auto-deployed on push to main via GitHub Actions)
- **Contact form:** Netlify Function → Brevo
- **Exchange app:** Netlify Function → Netlify Blobs, no external mail service
- **DNS:** Spaceship, monitored nightly by GitHub Actions

Vanilla HTML/CSS/JS. No framework, no bundler. The root `package.json` exists
for exactly one reason: the `@netlify/blobs` dependency that the exchange
function (and only the exchange function) imports. It is not a signal that a
build step may be added. Do not add further dependencies or tooling without
asking.

### Current state

The real site is published. `maintenance/` is retained but **deliberately not
published** — it is the emergency takedown switch, nothing more.

---

## 2. Layout

```
netlify.toml              Company-site Netlify config. Lives at repo root on purpose.
functions/                Netlify Functions -> Brevo + exchange. NOT under site/, never published
  contact.mjs             Contact form -> Brevo
  exchange.mjs            SCI Exchange: public API + admin panel
  exchange-lib/
    store.mjs             Netlify Blobs wrapper (JsonStore, lazy import; SKY_EXCHANGE_TEST stubs it)
    validate.mjs          Amounts, honeypot, proof MIME/size, tokens
    auth.mjs              scrypt verify + HMAC JWTs + refresh cookie
package.json              Sole dep @netlify/blobs (needed by exchange.mjs only)
test/                     Node tests. NOT under site/, never published
  main.test.mjs           Contact form, client side
  contact.test.mjs        Contact form, server side
  exchange.test.mjs       Exchange, server side (46 tests)
  exchange-client.test.mjs Exchange + admin, client side (VM fake DOM)
site/                     Company site publish root
  index.html              Landing
  about.html              Studio and founder
  work.html               Project catalogue
  math.html               A Noob Mathematician
  contact.html            Contact form
  exchange.html           SCI Exchange converter + order form
  orders.html             Order tracking + proof upload
  admin.html              SCI Exchange admin (noindex, not in sitemap)
  404.html                Real 404 page, and the target of the deny rules
  robots.txt, sitemap.xml
  assets/styles.css       All styling
  assets/main.js          Nav toggle, footer year, contact form
  assets/exchange.js      Converter, order form, tracking, proof
  assets/admin.js         Admin panel logic
  assets/posts.js         Facebook post lists (BOTH EMPTY - see §6)
  assets/favicon.svg
  founder/                Founder portfolio publish root (separate Netlify site)
maintenance/              Emergency fallback, NOT published
infra/
  dns_doctor.py           Read-only DNS health check
  test_dns_doctor.py      Parser tests (39 tests)
.github/workflows/
  check.yml               Tests + syntax + link check on every push
  deploy.yml              AUTO-DEPLOYS on every push to main (see §4)
  dns-watch.yml           Nightly DNS check, files an issue on failure
```

`test/` and `functions/` are at the repo root **on purpose**. `publish = "site"`
would otherwise upload their source, which publishes the honeypot field name,
the rate-limit numbers and the Brevo wiring comments as plain text. This
actually happened: `/test/*.test.mjs` and `/functions/contact.mjs` served 200 on
`skycreation.dev` until they were moved. Do not put them back under `site/`.

---

## 3. Commands

```sh
# Tests - CI runs exactly these
node --test test/*.test.mjs             # 69 tests (23 contact/exchange infra + 46 exchange)
python3 -m unittest discover -s infra   # 39 tests

# Deploy happens automatically on every push to main (both sites; deploy.yml).
# Manual deploy is the same commands the workflow runs (see §4, §5):
netlify deploy --dir=site --prod
# Founder: run from inside site/founder so THAT netlify.toml is discovered.
# netlify-cli has no --config flag (see §4), and --site is required because
# the local project link points at the company site.
cd site/founder
netlify deploy --dir=. --prod --site b851f1db-a2f0-4f67-81aa-6798f5296ab6
cd ../..

# DNS check locally (needs dig)
python3 infra/dns_doctor.py
python3 infra/dns_doctor.py --json
```

---

## 4. DO NOT break these

### Deploys are automatic on push to main

`deploy.yml` runs on every push to `main` (paths: `site/**`, `functions/**`,
`netlify.toml`, `deploy.yml`; also `workflow_dispatch`) and deploys **both**
sites — company via `netlify deploy --dir=site --prod`, founder from inside
`site/founder/`. It runs the Node and Python test suites first and fails the
deploy if they do not pass.

Netlify is *not* linked to the repo in the UI; the workflow uses
`NETLIFY_AUTH_TOKEN` and explicit site IDs. A push that only touches files
outside those paths triggers no deploy. That property is what keeps the founder
repo changes from firing a company deploy: founder lives under `site/founder/`
so it is inside `site/**`, which means ANY founder change DOES redeploy the
company site too. Founder is a static page, so that is harmless — just know it
happens.

Manual `netlify deploy --dir=site --prod` is the same command the workflow
runs; keep their behaviour identical.

### `--dir` overrides `[build] publish`

```sh
netlify deploy --dir=. --prod              # BREAKS the company site: 404 at /
netlify deploy --dir=site --prod           # company site
cd site/founder                            # founder - see below
netlify deploy --dir=. --prod --site b851f1db-a2f0-4f67-81aa-6798f5296ab6
cd ../..
```

Passing the repo root uploads the whole tree; there is no `index.html` at the
top level, so `/` 404s on the company site. This has already happened once.

Deploy the founder site only against the founder Netlify project, and run the
command **from inside `site/founder/`** so that directory's `netlify.toml` is
the one discovered. Doing it from the repo root reads this file instead, which
bundles `functions/` onto the founder project and applies the `/founder` 301
redirects below to the founder site itself.

**`netlify deploy` has no `--config` flag.** netlify-cli 27.10.2 rejects
`--config site/founder/netlify.toml` with `unknown option`. This repo documented
that flag for a while; it never worked. Config selection comes from the working
directory, which is the whole reason for the `cd`. If you find a founder
one-liner that passes `--config`, it is broken — fix the doc, do not paste it.

### Never publish anything that is not the site

`publish = "site"` uploads **everything** under `site/`, as static files, to a
public URL. Tests and the contact function used to live there and did exactly
that: `https://skycreation.dev/functions/contact.mjs` served the full source,
which discloses the honeypot field name (`company`), the rate-limit numbers and
the Brevo wiring. Honeypot detection only works if the attacker does not know
the field name.

`test/` and `functions/` therefore live at the repo root. If you move them back
under `site/`, the belt-and-suspenders `/test/*` and `/functions/*` deny rules
in `netlify.toml` will 404 them — those rules exist so this cannot silently
come back, not so they can be relied on instead of the layout.

After any deploy, check the source you did not mean to publish:

```sh
curl -o /dev/null -w "%{http_code}\n" https://skycreation.dev/functions/contact.mjs  # want 404
curl -o /dev/null -w "%{http_code}\n" https://skycreation.dev/test/main.test.mjs     # want 404
```

### Extensionless URLs are canonical

Netlify runs `pretty_urls`, so `/about` and `/about.html` both serve. **Only the
extensionless form may appear in links, canonicals and `og:url`.** The `.html`
form was the one being advertised to search engines and social cards.

If you add a page, link to it as `/newpage` and set
`<link rel="canonical" href="https://skycreation.dev/newpage">`.

### Never show "sent" without a send

The contact form once had a "minimum fill time" gate on both client and server.
It showed "Message sent" without calling the API if the page was under 1.2
seconds old. Real enquiries were silently lost — anyone using autofill or a
password manager. It never worked as anti-bot either, because it trusted a
caller-supplied timestamp.

**Do not re-add any timing gate.** The defences that work are the honeypot
(`name="company"`, hidden) and the per-IP rate limit. `test/` asserts the
invariants: a fast submission must send, and the honeypot is the *only*
success-without-sending path.

Honeypot discards are logged on purpose — a message dropped deliberately should
be visible even though the bot is told it succeeded.

Note: `rateLimited()` in `contact.mjs` legitimately calls `Date.now()`. That is
the rate limiter working, not a timing gate. Do not remove it on sight.

### The exchange is a same-origin function with its own invariants

The SCI Exchange backend (`functions/exchange.mjs`) is the biggest thing in this
repo. It is covered by 45 server tests plus client wiring tests in a fake DOM;
keep it that way. Non-negotiable rules:

- **`route()` must `await` every handler.** A handler that `throw`s an
  `httpError(...)` while async leaks a rejected promise past the try/catch; the
  tests were written with this bug live and every route failed on the first run.
  If you see a bare `payload()` call without `await` in a dispatch, it is broken.
- **Tests must run without `npm install`.** CI never installs `@netlify/blobs`.
  All network paths are behind the lazy blob `Store` which `SKY_EXCHANGE_TEST`
  replaces with `InMemoryStore` (`store.mjs`). Do not import `@netlify/blobs` at
  module top level or call the real store anywhere the tests touch.
- **Never show "converted"/"ordered" without a server answer.** Same rule as the
  contact form, and the same trap: a client-side fill-time gate is worse than
  nothing because bots see the same pages. The honeypot (`company`) is the only
  success-without-persistence path, and its discards are logged deliberately.
- **Order details are redacted unless the caller holds the per-order viewToken.**
  A guest can always see that an order exists (id, status, timestamps) but the
  amounts, email and proof only resolve with the 48-hex token. The neighbour's
  obvious id must not leak your amounts.
- **Data lives in Netlify Blobs** (`SCI_EXCHANGE_ORDERS`, `SCI_EXCHANGE_PROOFS`).
  Deleting a blob store is irreversible loss of the order history. Treat it like
  `rm -rf`.
- **Rate limits and JWTs** mirror sci-exchange: 10 order creates / 10 admin
  logins per IP per 10 minutes; 15-minute HMAC access token, httpOnly refresh
  cookie rotated on use, alg:none and forged signatures rejected (an empty
  signature must throw `TokenError`, never a `RangeError` — `timingSafeEqual`
  throws on length mismatch; the length guard in `auth.mjs` exists for that).
- **The admin API is same-origin too.** `/api/admin/*` is rewritten by
  `netlify.toml` and `admin.html` uses no CORS. Do not "fix" it to require
  `Access-Control-Allow-Origin`; a REST client (Postman, curl) does not need
  CORS, but a same-origin password panel does not use it either. The passcode is
  verified server-side (scrypt); `EXCHANGE_ADMIN_PASSWORD` lives in Netlify env,
  never in client source.
- **`event.path` vs Netlify rewrites:** the function receives a rewritten path
  from `/api/exchange/*` and `/api/admin/*`. Routing uses `event.path` but a
  static `__exchange_path` fallback when the path is already resolved. With
  query strings, the token is read from `queryStringParameters`, not the path.
  The rewrite behaviour is worth a live check after each deploy (see §8).
- **Blobs reads are text unless you ask for a type, and v1 handlers are not
  auto-configured.** Two live bugs, both invisible to the 45 in-memory tests:
  1. `@netlify/blobs` `get()` returns JSON **text** unless given
     `{ type: 'json' }`, so every order was read as a string, `viewToken`
     matched nothing and the redaction never lifted. The `JsonStore` wrapper
     (`store.mjs`) hides that surface: both it and `InMemoryStore` share one
     contract — `get()` parses, `set()` stringifies objects and stores raw
     buffers. Never reach past the wrapper to the raw Store.
  2. The handler is v1 Lambda-style (exported `handler`), where Netlify does
     not inject the Blobs environment; first store open dies with
     `getEnvironmentContext2 is not a function`. `openStores(event)` calls
     `connectLambda(event)` when the event carries a `blobs` payload (v1
     only; the guard keeps v2 working via runtime globals).
- **Blobs is eventually consistent and v1 cannot opt out.** New keys are
  readable immediately; updates and deletions propagate within 60 s. Strong
  consistency is **unavailable in the v1 environment** — the SDK routes strong
  reads through an `uncachedEdgeURL` that `connectLambda(event)` never
  receives, so `getStore({ name, consistency: 'strong' })` throws at runtime.
  The app adapts, it does not fight: orders and history entries are append-only
  (written under new keys, read by prefix listing — `order:`, `rate:history:`,
  `audit:`) and admin transitions re-read once after 250 ms before reporting a
  state conflict. The `order:index`/`rate:history:index`/`audit:index`
  read-modify-write sentinels were removed and are filtered as inert if ever
  re-seen; `InMemoryStore` is strong by construction, so tests will never show
  any of this on their own.
- **`store.set(key, object)` on the real payload used to store `[object
  Object]`** — before the `JsonStore` wrapper landed, direct real-store writes
  of plain objects persisted garbage. The corrupted smoke-test rows were wiped
  with `netlify blobs:list`/`blobs:delete`/`blobs:set` (the CLI is linked to
  the company site). Treat the blob CLI as a first-class admin tool: `list`,
  `get`, `set --input`, `delete`.

### Authoritative DNS servers only answer for their own zone

**This was the hardest bug in the project and cost several wrong fixes.**

Brevo publishes DKIM as a **two-hop CNAME chain**:

```
brevo1._domainkey.skycreation.dev
  → b1.skycreation-dev.dkim.brevo.com
    → brevo5.dkim.brevo.com          ← the key is only here
```

Three separate faults each caused false "DKIM missing" reports:

1. The parser required records to start with `v=DKIM1`. That tag is optional in
   RFC 6376 and **Brevo omits it** — its records start `k=rsa;p=...`.
2. The chain walk followed only one alias when there are two.
3. **The real one:** `dns_doctor.py` asked the domain's authoritative nameservers
   (Spaceship) about every name. Asked for `b1.skycreation-dev.dkim.brevo.com`
   they return *nothing at all*, which is indistinguishable from the record not
   existing.

`Dig.serves()` now routes by zone: in-zone names go to the authoritative
servers, everything else goes to a recursive resolver. If you touch
`Dig.query()`, keep that split.

### `dns_doctor.py` exits non-zero when it reports findings

That is the normal case for a live domain. Do not wrap a `--json` call in a bare
`set -e` — it aborts before anything can read the output. `check.yml` handles
this deliberately; the comment there explains why.

### `node --test test/` is invalid

Node treats a bare directory as a module name and dies with `MODULE_NOT_FOUND`.
Use the glob, unquoted, so the shell expands it:
`node --test test/*.test.mjs`.

### The workflow path filter includes `.github/**`

So that a commit which only edits a workflow still gets checked. Do not remove
it — a broken CI fix cannot be verified by CI without this.

---

## 5. Netlify environment

Company site ID `19485f7b-5cc0-426e-a8a0-4ad43a5ea66a` (`sky-creation`).

Founder site ID `b851f1db-a2f0-4f67-81aa-6798f5296ab6` (`sky-creation-founder`).
Publish with `netlify deploy --dir=. --prod --site b851f1db-a2f0-4f67-81aa-6798f5296ab6`
run from **inside `site/founder/`**. `--site` is mandatory (the local link
points at the company site) and the working directory is what selects the
config — see §4, `netlify deploy` has no `--config` flag.
Custom domain `founder.skycreation.dev` is attached; Spacehip `founder` CNAME must target
`sky-creation-founder.netlify.app` for traffic to leave GitHub Pages.

| Variable | Value |
| --- | --- |
| `BREVO_API_KEY` | Brevo v3 key |
| `CONTACT_TO` | `contact@skycreation.dev` |
| `CONTACT_FROM` | `contact@skycreation.dev` (verified sender) |
| `EXCHANGE_JWT_SECRET` | **required** for admin login; random high-entropy string |
| `EXCHANGE_ADMIN_PASSWORD` | **required** for admin login; the `/admin` passcode |
| `EXCHANGE_RATE_DEFAULT` | optional; first-day THB→MMK rate (default 128.5) |

Brevo vars are already set on the live site. **The two exchange vars are too**
(production context, Functions scope), working and live-tested; note netlify-cli
`env:list` shows nothing for the **dev** context — that is expected, the desktop
link is unrelated to the live deploy (see §6). `EXCHANGE_RATE_DEFAULT` remains optional/unset.

**`BREVO_API_KEY` is intentionally not marked secret.** The free plan rejects a
secret in the `post_processing` scope, and restricting to `functions` needs Pro —
so there is no way to store a real secret on this plan. It is still server-side:
the function reads it from the environment and it is never bundled into the
deployed site. Do not "fix" this by moving it into client-side code.

Verified Brevo senders: `contact@`, `founder@`, `accountant@` (all
`@skycreation.dev`).

**Do not rotate the credentials the user supplied.** They were given
explicitly and verified working. Changing them breaks a working mail path.

---

## 6. Open work

| Item | State |
| --- | --- |
| `site/assets/posts.js` | Both `company` and `math` arrays are **empty**. Sections auto-hide until populated. Needs the user's actual Facebook post text — do not invent content. |
| Publish layout | **Done.** `test/` and `functions/` moved to the repo root, company redeployed, `/test/*` and `/functions/*` return 404. See §4 "Never publish anything that is not the site". |
| Company robots/sitemap | **Done.** `site/robots.txt` and `site/sitemap.xml` live (five extensionless URLs). Add a URL to both when a page is added. |
| Founder Netlify cutover | Done. Site `sky-creation-founder` serves `founder.skycreation.dev` (CNAME → `sky-creation-founder.netlify.app`). `waiyantunoo.github.io` redirects to the branded URL. |
| GitHub Pages custom domain | Must stay **cleared** on `waiyantunoo.github.io`. Re-adding `founder.skycreation.dev` as a Pages custom domain hijacks every `github.io/*` path and 404s the visualiser project sites. |
| Turn off Powered by Netlify badge | Done via API (`built_with_badge_enabled: false`) on company and founder sites. |
| Deploy automation | **Done.** `deploy.yml` auto-deploys both sites on every push to main (`site/**`, `functions/**`, `netlify.toml`, `deploy.yml` paths; tests run first). Manual CLI deploys still work and are the same commands. |
| `SPACESHIP_API_KEY` / `SPACESHIP_API_SECRET` | **Still not in Actions** (`gh secret list` is empty). `dns-watch.yml` already references them behind `continue-on-error: true`, so the cross-check step is skipped rather than failing. Needs the keys rotated and set as repo secrets. |
| `Sky-Creation/zz-write-probe` | **Done.** Deleted; `gh repo view` no longer resolves it. |
| Org default permission | Reverted to `read` (was temporarily `write` during diagnostics). Re-verified as `read`. |
| Exchange on the live site | **Done, or as done as it gets.** All public routes live-verified (rate seed, calculate, order create, redaction, view-token lift, list resolver, proof round-trip). `EXCHANGE_JWT_SECRET` + `EXCHANGE_ADMIN_PASSWORD` are set on Netlify (production context, Functions scope; generated values, held by the user) and the admin surface is live-verified end to end: login wrong/correct, session, stats, orders list, rates GET/POST, open toggle, refresh rotation (replay → 401), logout, audit log, delete. approve→complete back-to-back works via the 250 ms re-read; legacy `order:index`/`rate:history:index`/`audit:index` keys were deleted from the store. Blob stores now hold only real data: `setting:open`, `rate:current`, `rate:history:*`, `audit:*`, self-expiring `session:*`. `EXCHANGE_RATE_DEFAULT` remains optional/unset. |

**Unverified claim:** Brevo returns `{"ok":true}` and accepts mail, but Netlify's
log API is not available with the current token, so honeypot discards have never
been confirmed to appear in logs. Worth checking in the Netlify dashboard.

---

## 7. Conventions

- British spelling in prose ("behaviour", "recognise"); match the surrounding text
- Plain ES5-ish JavaScript, no build step, no dependencies
- Commit messages explain **why**, not what. Several here document a bug that
  would otherwise be reintroduced. Keep that up.
- Tests are expected for anything touching the contact form, the exchange or
  the DNS parsers. All three were wrong for a long time precisely because
  nothing ran.
- CSS lives in `site/assets/styles.css`. Inline `style` attributes were removed
  deliberately; use the existing classes or add a rule.

---

## 8. Verified state at handoff

- 69 Node tests, 39 Python tests passing; CI green on `main` (exchange server +
  client suites added, including a regression pinning the blob text-vs-JSON
  contract)
- DNS watch: **12 pass, 0 warn, 0 fail** (was 0 pass / 3 fail)
- All five pages return 200 on `https://skycreation.dev`; `/exchange`,
  `/orders` and `/admin` return 200; `/app` 301s to `/exchange`
- `/test/*` and `/functions/*` return **404**; `/robots.txt` and `/sitemap.xml`
  return **200** (verified against the live domain after redeploy)
- Contact form delivers end-to-end; honeypot, validation and the 16 KB body
  guard all exercised by `test/`
- Founder page checked by CI: canonical + `og:url` on the founder host, JSON-LD
  `email` is a bare address matching the visible mailto, no `target="_blank"`
  without `noopener`
- DNS: apex `A @` → `75.2.60.5`, `CNAME www` → `sky-creation.netlify.app`,
  valid TLS, `www` → apex 301. DKIM, SPF, DMARC and the `founder` CNAME present.

The DNS watch workflow files one tracking issue on failure, comments on it
rather than opening duplicates, and closes it when DNS recovers. That lifecycle
has been exercised and works.