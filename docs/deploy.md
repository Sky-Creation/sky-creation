# Deploying

Purpose: how a change reaches `skycreation.dev` and `founder.skycreation.dev`,
and the two commands that will break the site if you get them wrong.

Read this when: you are publishing, rolling back, adding an environment
variable, or taking the site down.

## The normal path: push to main

Deploys are automatic. A push to `main` that touches `site/**`, `functions/**`,
`netlify.toml`, `package.json`, `package-lock.json` or
`.github/workflows/deploy.yml` runs `deploy.yml`:
it runs the Node and Python suites first, **fails the deploy if they do not
pass**, then publishes both sites.

| Site | Command the workflow runs |
| --- | --- |
| Company | `netlify deploy --dir=site --prod` |
| Founder | `netlify deploy --dir=. --prod --site b851f1db-…` from inside `site/founder/` |

Netlify is **not** linked to the repository in the Netlify UI. The workflow
authenticates with `NETLIFY_AUTH_TOKEN` and explicit site IDs. Do not use
Netlify's "Import an existing project" flow — that would double-deploy.

A push that touches only files outside those paths (for example `docs/` or
`infra/`) triggers **no deploy**. Note that because the founder lives under
`site/founder/`, **any founder change also redeploys the company site**. Founder
is static, so that is harmless; just know it happens.

## The manual fallback

The manual commands are the same ones the workflow runs, so behaviour stays
identical.

```sh
# Company site
netlify deploy --dir=site --prod
# or, from a fresh clone with no local link:
netlify deploy --dir=site --prod --site 19485f7b-5cc0-426e-a8a0-4ad43a5ea66a

# Founder portfolio — run FROM inside site/founder:
cd site/founder
netlify deploy --dir=. --prod --site b851f1db-a2f0-4f67-81aa-6798f5296ab6
cd ../..
```

### `--dir` overrides `[build] publish`

This has broken the company site once already:

```sh
netlify deploy --dir=. --prod      # BREAKS the company site: 404 at /
```

Passing the repository root uploads the whole tree. There is no `index.html` at
the top level, so `/` 404s. Always point `--dir` at the directory you intend to
publish: `site` for the company, `.` (from inside `site/founder`) for the founder.

### The founder deploy has two traps

1. **Run it from inside `site/founder/`.** Config selection comes from the
   working directory. Running from the repo root reads the root `netlify.toml`,
   which bundles `functions/` onto the founder project and applies the root
   `/founder` 301 redirects to the founder site itself.
2. **`netlify deploy` has no `--config` flag** (netlify-cli 27.10.2 rejects it
   with `unknown option`). Older notes in this repo documented
   `--config site/founder/netlify.toml`; it never existed. If you find a
   one-liner that passes `--config`, it is broken — fix the doc, do not run it.

`--site` is mandatory for the founder because the local project link points at
the company site.

### Fresh clone

`.netlify/state.json` is gitignored, so a fresh clone has no site linked. Pass
`--site <id>` explicitly (or run `netlify link`) if the CLI cannot work it out.

## Environment variables

Set Netlify **Site settings → Environment variables** on the **company** site.
The founder site is static and needs none of them.

| Variable | Value |
| --- | --- |
| `BREVO_API_KEY` | Brevo v3 API key |
| `CONTACT_TO` | `contact@skycreation.dev` |
| `CONTACT_FROM` | a Brevo-verified sender (optional; falls back to `CONTACT_TO`) |
| `EXCHANGE_JWT_SECRET` | random high-entropy string; signs admin tokens |
| `EXCHANGE_ADMIN_PASSWORD` | input to `scripts/seed-admin.mjs` only; not read at runtime |
| `EXCHANGE_RATE_DEFAULT` | optional first-day THB→MMK rate (defaults to 128.5) |
| `RATE_LIMIT_HMAC_KEY` | ≥ 32 chars; required for contact / exchange / admin rate limits |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (shared rate limiter) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |

Via the API, the account endpoint takes the site as a query parameter and the
body as an array of `{key, values}` objects:

```sh
POST /api/v1/accounts/{account_id}/env?site_id={site_id}
[{"key":"BREVO_API_KEY","values":[{"context":"all","value":"..."}]}]
```

**Leave `is_secret` off on the free plan.** A secret may not run in the
`post_processing` scope, and restricting it to `functions` requires Pro — the
two rules together leave no way to store a secret. The key is still server-side:
the function reads it from the environment and it is never bundled into the
deployed site. Do not "fix" this by moving a key into client code.

Do not rotate the credentials the user supplied; they were verified working and
changing them breaks a working mail path.

## DNS records (Spaceship)

Add the domain in Netlify **Domain settings**, then copy the exact records
Netlify shows into Spaceship rather than guessing — Netlify's apex record
differs by setup. Current state:

| Name | Type | Value |
| --- | --- | --- |
| `@` | A | `75.2.60.5` |
| `www` | CNAME | `sky-creation.netlify.app` |
| `founder` | CNAME | `sky-creation-founder.netlify.app` |

Keep the existing Spaceship MX/SPF and the Brevo DKIM/DMARC records. `www`
301s to the apex. Do **not** set `founder.skycreation.dev` as a GitHub Pages
custom domain on `waiyantunoo.github.io` — it hijacks every `github.io/*` path,
including the maths visualiser project sites. See [`decisions.md`](decisions.md).

## Housekeeping done once

- **Powered by Netlify badge**: turned off via the API
  (`built_with_badge_enabled: false`) on both sites.
- **Founder Base directory**: setting it to `site/founder` in the dashboard
  makes that `netlify.toml` authoritative for builds started there.

## Taking the site down (emergency)

`maintenance/` holds a "coming soon" page and is deliberately **not published**.
It is the emergency takedown. To use it:

```toml
# netlify.toml
publish = "maintenance"
```

```sh
netlify deploy --dir=maintenance --prod
```

Then revert the line and redeploy to bring the real site back. Keep the contact
function deployed while the maintenance page is live (the function lives in the
root config, so it stays).

## Rolling back

Netlify keeps previous deploys. The fastest safe rollback is to re-run the
deploy for a known-good commit:

```sh
git checkout <good-commit>
netlify deploy --dir=site --prod
```

or use Netlify's dashboard to publish an earlier deploy. Re-run the test suites
before restoring `main`.

## After any deploy

Check that the sources you did not mean to publish are still 404:

```sh
curl -o /dev/null -w "%{http_code}\n" https://skycreation.dev/functions/contact.mjs  # want 404
curl -o /dev/null -w "%{http_code}\n" https://skycreation.dev/test/main.test.mjs     # want 404
curl -o /dev/null -w "%{http_code}\n" https://skycreation.dev/api/posts              # want 200
```

And confirm the exchange and admin rewrites resolve (see [`runbook.md`](runbook.md)).
