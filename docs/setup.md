# Local setup

Purpose: get a working checkout and run the checks without touching production.

Read this when: you have just cloned the repository, or you want to run the
tests or the DNS doctor locally.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node | 22 | the Netlify Functions and the Node test suite |
| Python | 3.12 | `infra/dns_doctor.py` and its tests |
| `dig` | any | `dns_doctor.py` (apt `dnsutils` / brew `bind`) |
| `netlify-cli` | 27.x | manual deploys only (see [`deploy.md`](deploy.md)) |

There is **no `npm install` step for tests.** CI never installs
`@netlify/blobs` or Upstash; the suite stubs Blobs with `InMemoryStore` and
uses a memory rate limiter. Root `package.json` holds the function runtime deps
(`@netlify/blobs`, `@upstash/redis`, `@upstash/ratelimit`) for deploy bundling.

## Clone and run the tests

```sh
git clone <repo-url> sky-creation
cd sky-creation

# Node suite (105 tests)
node --test test/*.test.mjs

# Python DNS parser suite (48 tests)
python -m unittest discover -s infra
```

No environment variable is needed for most cases: the suites build the functions
with `createServer({ store: new InMemoryStore(), ... })`, so they never touch
Netlify Blobs or Upstash. `SKY_EXCHANGE_TEST=1` is the switch that makes
`openStores()` — the path the real `handler` uses — return in-memory stores and
a memory limiter; set it only if you are
exercising the handler end to end.

Do **not** run `node --test test/` without the glob — Node treats the bare
directory as a module name and dies with `MODULE_NOT_FOUND`.

More detail on what each suite covers is in [`testing.md`](testing.md).

## Environment variables

Nothing is required to run the tests. The full inventory, where each value
lives and how to rotate it, is in [`secrets.md`](secrets.md). For local
experiments the relevant names are:

| Variable | Used by |
| --- | --- |
| `SKY_EXCHANGE_TEST` | test store switch |
| `BREVO_API_KEY` | `functions/contact.mjs` (server-side only) |
| `CONTACT_TO`, `CONTACT_FROM` | `functions/contact.mjs` |
| `EXCHANGE_JWT_SECRET` | admin access/refresh tokens |
| `EXCHANGE_RATE_DEFAULT` | optional first-day THB→MMK seed rate |
| `SPACESHIP_API_KEY`, `SPACESHIP_API_SECRET` | `dns_doctor.py --control-plane` |

Never commit a value. Use an untracked local file or the shell environment.

## Seeding the admin account locally

The admin function reads one user row from `SCI_ADMIN` under `user:primary`.
To create one:

```sh
node scripts/seed-admin.mjs --password <pw>
```

Options: `--email`, `--username`, `--name`, `--out <file>`, `--force`. The
password can also come from `EXCHANGE_ADMIN_PASSWORD`. The script only **writes
a file** (`seed-admin-out.json` by default, gitignored); it does not push to
Netlify. To load it into the live store:

```sh
netlify blobs:set SCI_ADMIN user:primary --input seed-admin-out.json
```

See [`runbook.md`](runbook.md) for the recovery path if the admin account is
lost, and `AGENTS.md` §5 for the seed command.

## Running the DNS doctor

```sh
python infra/dns_doctor.py                    # table
python infra/dns_doctor.py --json             # machine-readable
python infra/dns_doctor.py --control-plane    # also read the Spaceship API
```

Exit codes are meaningful: `0` healthy (warnings allowed), `1` at least one
failure, `2` could not run (usually `dig` missing). A non-zero exit is the
**normal** case for a live domain with warnings, so do not wrap a `--json` call
in a bare `set -e`. See [`dns.md`](dns.md).

## Editing content

- Pages: `site/*.html`; styling in `site/assets/styles.css` (no inline `style`
  attributes).
- Post lists: managed from `/admin` → Posts, not by editing `posts.js` (that
  file is only the fallback).
- Contact addresses: `site/contact.html` plus `CONTACT_TO`/`CONTACT_FROM`, kept
  consistent.

A new page should be linked as `/newpage`, set
`<link rel="canonical" href="https://skycreation.dev/newpage">`, and added to
both `site/robots.txt` and `site/sitemap.xml`.

## What to read next

- Understand the moving parts: [`architecture.md`](architecture.md).
- Publish something: [`deploy.md`](deploy.md).
- Rules you must not break: [`../AGENTS.md`](../AGENTS.md).
