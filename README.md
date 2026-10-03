# skycreation.dev

Official website for **Sky Creation Innovations**, plus the DNS tooling that
keeps the domain healthy.

- Live site: <https://skycreation.dev>
- Founder portfolio (same repo, separate Netlify site): <https://founder.skycreation.dev>

Everything here is free-tier only: Netlify for hosting, Brevo for the contact
form, GitHub Actions for DNS monitoring, Spaceship for DNS.

If you are an AI agent or picking this up cold, read [AGENTS.md](AGENTS.md) first.

## Layout

```
netlify.toml                        Company-site Netlify config (repo root)
site/                                Company site publish root
  index.html                        Landing
  about.html                        Studio and founder
  work.html                         Project catalogue
  math.html                         A Noob Mathematician
  contact.html                      Contact form
  assets/styles.css                 All styling
  assets/main.js                    Nav, footer year, contact form
  assets/posts.js                   Facebook post lists
  assets/favicon.svg
  functions/contact.mjs             Netlify Function -> Brevo
  test/                             Node tests for the form, client and server
  founder/                          Founder portfolio (separate Netlify site)
    index.html                      Portfolio (Tailwind CDN)
    images/                         Profile and OG images
    robots.txt, sitemap.xml
    netlify.toml                    Headers when founder site base is this dir
maintenance/                        Emergency fallback, not published
  index.html                        "Coming soon" page
  assets/favicon.svg
infra/
  dns_doctor.py                     Read-only DNS health check
  test_dns_doctor.py                Parser tests
.github/workflows/
  dns-watch.yml                     Nightly DNS check
  check.yml                         Tests, syntax and link check on every push
```

There is no build step.

## Which site is live

`netlify.toml` sets `publish = "site"`, so the finished site is live.

`maintenance/` is kept in the repository but deliberately not published. To
take the site down to the "coming soon" page, change one line and deploy:

```toml
publish = "maintenance"
```

```sh
netlify deploy --dir=maintenance --prod
```

### Deploying from the CLI

Deploys are manual: this repository is not linked to Netlify, so pushing does
not publish anything.

`--dir` overrides `[build] publish`. Passing the repository root uploads the
whole tree and the site 404s at `/`, because there is no `index.html` at the
top level. Point `--dir` at the directory you actually want published:

```sh
netlify deploy --dir=site --prod             # company site (skycreation.dev)
netlify deploy --dir=site/founder --prod     # founder portfolio (founder.skycreation.dev)
netlify deploy --dir=maintenance --prod      # the coming-soon fallback
```

Use the Netlify site that matches the content: company site for `site`, founder
site for `site/founder`. `--dir` overrides `[build] publish`. Passing the
repository root uploads the whole tree and the company site 404s at `/`.

The company functions directory still comes from the root `netlify.toml`, so
the contact function is deployed with the company-site command.

## Checks

Run these before pushing; CI runs the same commands.

```sh
node --test site/test/*.test.mjs      # contact form, client and server
python3 -m unittest discover -s infra # DNS record parsers
```

`site/test/` covers the contact form specifically because it once reported
success for messages it never sent. A fast submission, a filled honeypot, a
provider failure and a missing API key are each asserted, so the "sent"
confirmation can only appear when a send was actually attempted.

## Deploy

1. Create the GitHub repository and push this tree.
2. In Netlify: **Add new site -> Import an existing project**, pick the repo.
   Netlify reads `netlify.toml`, so no manual build settings are needed.
3. In Netlify **Site settings -> Environment variables**, set:

   | Variable | Value |
   | --- | --- |
   | `BREVO_API_KEY` | Brevo v3 API key |
   | `CONTACT_TO` | `contact@skycreation.dev` |
   | `CONTACT_FROM` | a sender address already verified in Brevo (optional) |

   `CONTACT_FROM` should be a verified Brevo sender. If it is omitted, the
   function uses `CONTACT_TO`, so make sure whichever address is used has been
   verified in Brevo or delivery will fail.

   These are set on the live site already. Setting them via the API needs the
   account endpoint with the site passed as a query parameter, and the body as
   an array of key/values objects:

   ```sh
   POST /api/v1/accounts/{account_id}/env?site_id={site_id}
   [{"key":"BREVO_API_KEY","values":[{"context":"all","value":"..."}]}]
   ```

   Leave `is_secret` off on a free plan. A secret may not run in the
   `post_processing` scope, and restricting it to `functions` requires Pro, so
   the two rules together leave no way to store a secret. The key is still
   server-side: the function reads it from the environment and it is never
   bundled into the deployed site.

4. In Brevo, verify the sending domain so DKIM is signed.
5. In Netlify **Domain settings**, add `skycreation.dev`. Netlify then shows the
   exact apex and `www` records it needs — copy those values into Spaceship
   rather than guessing them, because Netlify's apex record differs by setup.

   Done: apex `A @` → `75.2.60.5`, `CNAME www` → `sky-creation.netlify.app`.
   Keep the existing Spaceship MX/SPF, Brevo DKIM/DMARC records.

   Done: `founder` CNAME → `sky-creation-founder.netlify.app`. Do **not** set
   `founder.skycreation.dev` as a GitHub Pages custom domain on
   `waiyantunoo.github.io` — that redirects every `github.io/*` path onto the
   founder host and breaks the visualiser project sites.

6. Turn off the **Powered by Netlify** badge (company and founder projects):
   Project configuration → General → Powered by Netlify badge → off → Save.
   Already done via API (`built_with_badge_enabled: false`).

### Founder portfolio deploy

Source: `site/founder/`. Netlify site ID `b851f1db-a2f0-4f67-81aa-6798f5296ab6`
(`sky-creation-founder`), custom domain `founder.skycreation.dev`:

```sh
netlify deploy --dir=site/founder --prod --site b851f1db-a2f0-4f67-81aa-6798f5296ab6 --config site/founder/netlify.toml
```

Pass `--config site/founder/netlify.toml` so the company contact function is
not bundled onto the founder site.

## DNS monitoring

`infra/dns_doctor.py` is read-only. It resolves records with `dig`, preferring
the domain's own authoritative nameservers for names inside the zone, and
falling back to a recursive resolver for anything delegated elsewhere. That
distinction matters: Brevo publishes DKIM as a two-hop CNAME chain, and the
local authoritative servers know nothing about the `brevo.com` end of it, so
asking them returns nothing at all.

It checks:

- delegation and nameservers
- inbound mail: MX and SPF for Spaceship forwarding
- outbound mail: Brevo DKIM selectors, domain verification, DMARC policy
- website: apex, `www`, and the `founder` subdomain

Run it locally (needs `dig`: `apt install dnsutils` / `brew install bind`):

```bash
python3 infra/dns_doctor.py                    # table
python3 infra/dns_doctor.py --json             # CI-friendly
python3 infra/dns_doctor.py --control-plane    # also read the Spaceship API
```

`--control-plane` needs `SPACESHIP_API_KEY` and `SPACESHIP_API_SECRET` in the
environment. It only ever reads. Exit codes: `0` healthy (warnings allowed),
`1` at least one failure, `2` could not run.

The scheduled workflow runs nightly and on demand from the Actions tab. On
failure it files or updates a single tracking issue rather than piling up new
ones, and closes that issue when DNS recovers. The two Spaceship secrets are
only needed for the optional cross-check; without them the rest still runs.

## Secrets

Never commit credentials. The three that matter:

| Secret | Where it lives |
| --- | --- |
| `BREVO_API_KEY` | Netlify environment variables |
| `SPACESHIP_API_KEY` | GitHub Actions secrets |
| `SPACESHIP_API_SECRET` | GitHub Actions secrets |

The contact function logs provider errors without ever printing the API key.

## Editing content

- Company, services, projects, founder: `site/*.html`
- Mathematics pages and social links: `site/math.html`
- Facebook posts: `site/assets/posts.js`. Both lists start empty; a section
  with no posts is hidden rather than shown as a bare heading.
- Contact addresses: `site/contact.html` and the `CONTACT_TO` / `CONTACT_FROM`
  Netlify variables — keep the visible address and the receiving address
  consistent, otherwise mail will be sent to somewhere nobody reads.

Links between pages are root-relative and extensionless (`/about`, not
`/about.html`): Netlify serves both, but only the extensionless form is the
canonical address.

## Licence

MIT. See [LICENSE](LICENSE).
