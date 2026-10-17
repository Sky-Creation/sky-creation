# Secrets and credentials

Purpose: the full inventory of credentials, where each one lives, and how to
rotate it safely.

Read this when: you are setting up a fresh environment, rotating a credential,
or unsure whether a value belongs in the repo (it does not).

**No credential value appears in this repository or in these docs.** Only
variable *names* do. Never commit a value; use the Netlify UI, GitHub Actions
secrets, or an untracked local file.

## Inventory

| Name | Where it lives | Used by | Notes |
| --- | --- | --- | --- |
| `BREVO_API_KEY` | Netlify env (company) | `functions/contact.mjs` | intentionally **not** marked secret — see below |
| `CONTACT_TO` | Netlify env (company) | `functions/contact.mjs` | not a secret |
| `CONTACT_FROM` | Netlify env (company) | `functions/contact.mjs` | optional; must be a Brevo-verified sender |
| `EXCHANGE_JWT_SECRET` | Netlify env (company) | admin access/refresh tokens | required for admin login |
| `EXCHANGE_ADMIN_PASSWORD` | not read at runtime | input to `scripts/seed-admin.mjs` | see "Admin password" |
| `EXCHANGE_RATE_DEFAULT` | Netlify env (company) | exchange seed rate | optional; not a secret |
| `RATE_LIMIT_HMAC_KEY` | Netlify env (company) | contact / exchange / admin rate limits | required; ≥ 32 chars |
| `UPSTASH_REDIS_REST_URL` | Netlify env (company) | shared Upstash rate limiter | required in production |
| `UPSTASH_REDIS_REST_TOKEN` | Netlify env (company) | shared Upstash rate limiter | required in production |
| `NETLIFY_AUTH_TOKEN` | GitHub Actions secret | `deploy.yml` | deploys both sites |
| `SPACESHIP_API_KEY` | GitHub Actions secret | `dns-watch.yml` | read-only DNS cross-check |
| `SPACESHIP_API_SECRET` | GitHub Actions secret | `dns-watch.yml` | read-only DNS cross-check |

The admin account row (scrypt salt + hash) lives in the `SCI_ADMIN` blob store
under `user:primary`. It is not an environment variable and must never be.

Netlify runtime variables are set on the **company** site only; the founder site
is static and needs none.

## Why `BREVO_API_KEY` is not marked secret

On the free plan a secret may not run in the `post_processing` scope, and
restricting it to `functions` requires Pro — together there is no way to store a
real secret. It is still server-side: the function reads it from the environment
and it is never bundled into the deployed site. **Do not "fix" this by moving the
key into client code.**

## Setting Netlify environment variables

In the Netlify UI: **Site settings → Environment variables**. Via the API, the
account endpoint takes the site as a query parameter and the body as an array of
`{key, values}` objects:

```sh
POST /api/v1/accounts/{account_id}/env?site_id={site_id}
[{"key":"BREVO_API_KEY","values":[{"context":"all","value":"..."}]}]
```

Leave `is_secret` off (see above). After changing a variable, redeploy so the
function picks it up.

## Setting GitHub Actions secrets

```sh
gh secret set NETLIFY_AUTH_TOKEN
gh secret set SPACESHIP_API_KEY
gh secret set SPACESHIP_API_SECRET
```

Or via the repository's **Settings → Secrets and variables → Actions** page.

## Rotation

### Brevo API key

1. In Brevo: **SMTP & API → API keys**, create a new v3 key.
2. Update `BREVO_API_KEY` in the Netlify env.
3. Redeploy (or push) so the function reloads.
4. Send a test message through `/contact` and confirm it arrives.
5. Delete the old key in Brevo.

### `EXCHANGE_JWT_SECRET`

1. Generate a new random high-entropy string.
2. Replace the Netlify env value.
3. Redeploy. **Every existing admin access token and refresh session becomes
   invalid**, so the next login is required. That is the intended effect of a
   rotation.

### Admin password

The password is not an env value at runtime. Two ways to change it:

- **From the panel:** `/admin` → Account → set a new password (requires the
  current one; audited as `account.updated`).
- **By reseeding:** `node scripts/seed-admin.mjs --password <newpw>` then
  `netlify blobs:set SCI_ADMIN user:primary --input seed-admin-out.json`.
  Then delete existing `session:*` keys (or bump `authVersion` on the user
  row) so old refresh cookies stop working. The old password stops verifying
  immediately once the new hash is written.

### Spaceship API key

1. In Spaceship, create a new read-only API key (the integration only reads).
2. Update `SPACESHIP_API_KEY` and `SPACESHIP_API_SECRET` as Actions secrets.
3. Trigger the **DNS watch** workflow (`workflow_dispatch`) and confirm the
   `spaceship-api` finding is a pass.
4. Revoke the old key.

### Netlify auth token

1. Create a new personal access token in Netlify.
2. Update the `NETLIFY_AUTH_TOKEN` Actions secret.
3. Run **Deploy to Netlify** via `workflow_dispatch` to confirm.
4. Revoke the old token.

## Handling a leaked credential

1. Rotate it as above **first** — assume it is compromised.
2. Check the audit log at `/admin` → Audit for unexpected admin activity.
3. If an admin password may have leaked, reseed it and rotate
   `EXCHANGE_JWT_SECRET` to kill any live session.
4. Note: values pasted into a chat, ticket or shell history must be treated as
   leaked and rotated, even if they were never committed.

## Data is sensitive, not secret

The blob stores (`SCI_EXCHANGE_ORDERS`, `SCI_EXCHANGE_PROOFS`, `SCI_ADMIN`)
hold customer names, contact details, destination account numbers and payment
proofs. They are not credentials, but they are personal data: **deletions are
irreversible, and there is no backup.** Treat a store wipe like `rm -rf`, and
prefer deleting individual keys. See [`runbook.md`](runbook.md).

## Do not rotate what the user supplied

The Brevo and exchange credentials in use were supplied explicitly and verified
working. Changing them without cause breaks a working path. Rotate only when
asked, when a value has leaked, or per the schedule you are responsible for.
