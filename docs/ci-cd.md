# CI and CD

Purpose: the three GitHub Actions workflows — what triggers them, what they
run, and the parts that will silently stop protecting you if edited.

Read this when: you are changing a workflow, wondering why a push did or did not
deploy, or adding a check.

All three pin `ubuntu-24.04`, start with
`git config --global init.defaultBranch main` (to silence the git 3.0 branch
hint on the scratch init), and keep `permissions` minimal.

## `check.yml` — "Site checks"

**Triggers:** push and pull request to `main`, plus `workflow_dispatch`, on
paths `site/**`, `maintenance/**`, `infra/**`, `test/**`, `functions/**`,
`.github/**`, `package.json`, `package-lock.json`, `netlify.toml`.

The `.github/**` entry is deliberate: a commit that only edits a workflow still
gets checked, so a broken CI fix can be verified by CI. Do not remove it.

**Permissions:** `contents: read`.

Steps:

1. Syntax-check every JS/MJS file:
   `site/assets/*.js functions/*.mjs functions/exchange-lib/*.mjs` via
   `node --check`.
2. `node --test test/*.test.mjs` — the 103 Node tests (glob unquoted so the
   shell expands it).
3. `python3 -m unittest discover -s infra -v` — the 48 Python tests.
4. Smoke-test the DNS JSON report: run `dns_doctor.py --json`, tolerate its
   non-zero exit, then assert the output parses and has the expected shape. A
   missing `dig` is allowed to pass; a crash in our code is not.
5. Verify every internal link target exists, for both `site/*.html` and
   `maintenance/*.html`. Handles root-relative (`/about` → `.html` /
   `/index.html`) and page-relative links, and checks `src`/`srcset` as well as
   `href`.
6. Check the founder page: required files exist, `canonical` and `og:url` point
   at the founder host, JSON-LD parses with a bare email address, every
   `target="_blank"` has `rel="noopener"`, and the JSON-LD email matches a
   visible `mailto:`.

## `deploy.yml` — "Deploy to Netlify"

**Triggers:** push to `main` on paths `site/**`, `functions/**`,
`netlify.toml`, `package.json`, `package-lock.json`,
`.github/workflows/deploy.yml`; plus `workflow_dispatch`.

It does **not** trigger on `test/**` or `infra/**` alone, so a change confined to
those does not deploy. Note that founder changes live under `site/founder/`, so
any founder change **does** redeploy the company site too (harmless — founder is
static).

**Permissions:** `contents: read`. **Concurrency:** group `netlify-deploy`,
`cancel-in-progress: false`, so only one deploy runs at a time and the founder
deploy cannot race the company one.

Steps:

1. Checkout, Node 22, `npm install -g netlify-cli` (with
   `npm_config_loglevel: error` to mute the deprecated `node-domexception`
   warning).
2. `node --test test/*.test.mjs` and `python3 -m unittest discover -s infra` —
   **a failing suite fails the deploy.**
3. `npm install --no-audit --no-fund` — the deploy-only install. The exchange
   function imports `@netlify/blobs`, and netlify-cli bundles functions with
   esbuild without installing for them, so `node_modules` must exist first.
   `check.yml` deliberately never installs.
4. `netlify deploy --dir=site --prod` for the company site, with
   `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` from the secrets/env.
5. `cd site/founder && netlify deploy --dir=. --prod --site b851f1db-…` for the
   founder site.

Netlify is not linked to the repo in its UI; the workflow uses the auth token
and explicit site IDs. Do not use Netlify's "Import an existing project" flow.

## `dns-watch.yml` — "DNS watch"

**Triggers:** `workflow_dispatch` and the cron schedule `17 3 * * *`.

**Permissions:** `contents: read`, `issues: write`. **Concurrency:**
`dns-watch`.

Steps: install `dig`, run `dns_doctor.py` (tolerating the non-zero exit, then
exit with it), write `report.json`, run the Spaceship control-plane cross-check
**only if both secrets are present** (job-level env so `if:` can test them),
summarise to `$GITHUB_STEP_SUMMARY`, then open/update the tracking issue on
failure or close it on success. See [`dns.md`](dns.md).

## Secrets used by the workflows

| Secret | Workflow | Purpose |
| --- | --- | --- |
| `NETLIFY_AUTH_TOKEN` | `deploy.yml` | deploy both sites |
| `SPACESHIP_API_KEY` | `dns-watch.yml` | control-plane cross-check |
| `SPACESHIP_API_SECRET` | `dns-watch.yml` | control-plane cross-check |

They are GitHub Actions secrets; the Netlify runtime variables are separate and
live in the Netlify UI. Full inventory: [`secrets.md`](secrets.md).

## Traps

- **Do not remove `.github/**` from the `check.yml` path filter.** A workflow
  fix must be checkable by the workflow.
- **Do not add `continue-on-error` back to the control-plane step.** `747db1f`
  made it strict on purpose: a control-plane disagreement should fail the run.
- **Keep `node --test test/*.test.mjs` unquoted.** `node --test test/` is
  invalid.
- **Keep the deploy-time and manual commands identical** so behaviour does not
  drift.
- **Do not link the repo through Netlify's UI.** It would double-deploy.

## Adding a check

Put it in `check.yml` (it is the push gate) unless it is DNS-specific, in which
case extend `dns_doctor.py`. Prefer a real assertion over an eyeball, and leave
a comment explaining what regression it prevents — the existing steps do, and
that is why they survived.
