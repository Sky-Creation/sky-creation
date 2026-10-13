# Runbook

Purpose: concrete steps for the operational tasks and incidents this project
actually has.

Read this when: something is broken in production, or you need to inspect or
repair the live data.

The general rule when touching live data: **Netlify Blobs deletions are
irreversible.** `netlify blobs:delete` (and "delete store") is the equivalent of
`rm -rf`. Read before you delete.

## Health check

```sh
# Pages (want 200)
for p in / /about /work /math /contact /exchange /orders /admin; do
  printf "%s " "$p"; curl -s -o /dev/null -w "%{http_code}\n" "https://skycreation.dev$p"
done

# Route sanity
curl -s -o /dev/null -w "%{http_code}\n" https://skycreation.dev/app                 # want 301 -> /exchange
curl -s -o /dev/null -w "%{http_code}\n" https://skycreation.dev/api/posts           # want 200 {"company":[],"math":[]}
curl -s -o /dev/null -w "%{http_code}\n" https://skycreation.dev/api/admin/session   # want 401 (admin function, unauthenticated)

# Sources that must never be published (want 404)
curl -s -o /dev/null -w "%{http_code}\n" https://skycreation.dev/functions/contact.mjs
curl -s -o /dev/null -w "%{http_code}\n" https://skycreation.dev/test/main.test.mjs
```

If `/api/posts` returns 200 but the admin routes 404, the `/api/admin/*` or
`/api/posts` rewrite in `netlify.toml` is missing — they live in the admin
function, not the exchange one.

## "The admin login is gone"

The user row lives in `SCI_ADMIN` under `user:primary`. If it is missing or the
password is lost, reseed it:

```sh
node scripts/seed-admin.mjs --password <newpw>
netlify blobs:set SCI_ADMIN user:primary --input seed-admin-out.json
```

The CLI is linked to the company site. Seeding overwrites the row, so the old
password stops working immediately. The identifier is the seeded username or
email from the script output.

## Inspect the live blob stores

Treat the blob CLI as a first-class admin tool:

```sh
netlify blobs:list SCI_EXCHANGE_ORDERS
netlify blobs:get  SCI_EXCHANGE_ORDERS rate:current
netlify blobs:set  SCI_EXCHANGE_ORDERS setting:open --input open.json   # {"open":false}
netlify blobs:delete SCI_EXCHANGE_ORDERS order:<id>
```

Stores: `SCI_EXCHANGE_ORDERS` (orders, rate, settings), `SCI_EXCHANGE_PROOFS`
(images), `SCI_ADMIN` (user, sessions, audit, posts, settings).

Legacy `order:index`, `rate:history:index` and `audit:index` keys are inert if
ever seen; they were removed and the code filters them.

## Close or reopen the exchange

The storefront refuses new orders when the exchange is closed. Toggle it from
`/admin` → Exchange → Rates, or directly:

```sh
netlify blobs:set SCI_EXCHANGE_ORDERS setting:open --input open.json   # {"open":true}
```

## An order is "stuck" after approve → complete

Approve, then a rapid complete, can briefly read the previous state because
Blobs updates propagate within ~60 s. The code already re-reads once after
250 ms before reporting `Cannot complete an order in state …`. If you see that
error, wait a few seconds and retry — the earlier transition will have
propagated. It is not a bug to "fix" by removing the re-read.

## Rate looks wrong

The effective rate is, in order: `rate:current` (set by the panel) → the seeded
`setting:defaultRate` → `EXCHANGE_RATE_DEFAULT` → the built-in `128.5`. Reset
it from `/admin` → Exchange → Rates; the change is appended to
`rate:history:*` and audited as `rate.updated`.

## A proof image will not display

Proofs are JPEG/PNG/WebP up to 5 MB, stored in `SCI_EXCHANGE_PROOFS` and served
through the function with the per-order view token. The admin panel previews
them via a `blob:` URL, which is why the company CSP `img-src` includes `blob:`
and `data:`. If the image 403s for a guest, the caller is missing the token —
that is the redaction working, not a fault.

## Recover a lost token / wrong guest data

Refresh the page to re-read the URL, or use the id + token link from the order
confirmation. The token is a 48-hex string; without it the storefront returns
the redacted `publicOrder` (id, status, timestamps only).

## Tests fail in CI

`check.yml` runs on every push and on workflow edits. Reproduce locally with the
exact commands:

```sh
node --test test/*.test.mjs
python -m unittest discover -s infra
```

`node --test test/` (no glob) is invalid and will fail with `MODULE_NOT_FOUND`.
If a Python DNS test fails, note that `dns_doctor.py` exits non-zero when it
reports findings — that is normal, and `check.yml` handles it deliberately. Do
not wrap a `--json` call in a bare `set -e`.

## DNS watch filed an issue

`dns-watch.yml` runs nightly and on demand. On failure it files a single
tracking issue (or comments on the open one) and closes it when DNS recovers.
To reproduce:

```sh
python infra/dns_doctor.py
python infra/dns_doctor.py --control-plane    # needs SPACESHIP_API_KEY/SECRET
```

Common causes and their fixes are in [`dns.md`](dns.md). If the failure is only
`spaceship-api`, the Spaceship WAF may be rejecting the request — check the
`User-Agent` handling in `Spaceship._get`.

## Rotate a credential

See [`secrets.md`](secrets.md) for the full inventory and per-secret steps.
Broadly: update the value in Netlify (env vars) or GitHub (Actions secrets),
redeploy or re-run the workflow, then verify the affected path end to end.

## Take the site down / bring it back

The emergency takedown is documented in [`deploy.md`](deploy.md): switch
`publish` to `maintenance` and deploy, then revert. `maintenance/` is retained
and deliberately unpublished for exactly this.

## What not to do in an incident

- Do not delete a blob store to "reset" the app — order history is gone for
  good. Delete individual keys, or toggle settings.
- Do not add a client-side delay or "minimum fill time" to make a form feel
  safer — it hides real submissions (see [`contact.md`](contact.md)).
- Do not move `test/` or `functions/` to make a deploy simpler — that publishes
  their source.
- Do not add CORS headers to the admin API — it is same-origin by design.
