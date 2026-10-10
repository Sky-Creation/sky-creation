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
functions/                          Netlify Functions -> Brevo + exchange. NOT published
  contact.mjs                       Contact form -> Brevo (lives outside site/ on purpose - see AGENTS.md)
  exchange.mjs                      SCI Exchange app: public API + admin panel
  exchange-lib/                     store (Netlify Blobs), validation, auth
test/                               Node tests for the form, exchange and DNS-adjacent code. NOT published
  main.test.mjs                     Contact form, client side
  contact.test.mjs                  Contact form, server side
  exchange.test.mjs                 Exchange app, server side
  exchange-client.test.mjs          Exchange + admin, client side (VM)
site/                                Company site publish root
  index.html                        Landing
  about.html                        Studio and founder
  work.html                         Project catalogue
  math.html                         A Noob Mathematician
  contact.html                      Contact form
  exchange.html                     SCI Exchange converter + order creation
  orders.html                       Order tracking + proof upload
  admin.html                        SCI Exchange admin panel (links are noindex/nofollow)
  404.html                          Real 404 page (also the target of the deny rules)
  robots.txt, sitemap.xml
  assets/styles.css                 All styling
  assets/main.js                    Nav, footer year, contact form, charts
  assets/exchange.js                Converter, order form, tracking, proof upload
  assets/admin.js                   Admin panel logic (login, orders, rates, audit)
  assets/posts.js                   Facebook post lists
  assets/favicon.svg
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
# company site (skycreation.dev)
netlify deploy --dir=site --prod

# founder portfolio (founder.skycreation.dev). Run it FROM site/founder so
# that directory's netlify.toml is the one discovered - netlify-cli has no
# --config flag - and name the project, because the CLI's local link points
# at the company site.
cd site/founder
netlify deploy --dir=. --prod --site b851f1db-a2f0-4f67-81aa-6798f5296ab6
cd ../..

# the coming-soon fallback
netlify deploy --dir=maintenance --prod
```

Do not deploy the founder site from the repository root. The root
`netlify.toml` would be picked up instead, which bundles `functions/` onto the
founder project and applies the root `/founder` 301 redirects to the founder
site itself.

`.netlify/state.json` is gitignored, so a fresh clone has no site linked — pass
`--site 19485f7b-5cc0-426e-a8a0-4ad43a5ea66a` for the company site if the CLI
cannot work it out.

The contact function is declared in the root `netlify.toml`
(`functions = "functions"`), so it is uploaded by the company-site command.

## Checks

Run these before pushing; CI runs the same commands.

```sh
node --test test/*.test.mjs           # contact form, client and server
python3 -m unittest discover -s infra # DNS record parsers
```

`test/` covers the contact form specifically because it once reported
success for messages it never sent. A fast submission, a filled honeypot, a
provider failure and a missing API key are each asserted, so the "sent"
confirmation can only appear when a send was actually attempted.

## SCI Exchange app

The exchange (THB↔MMK cash conversion) is a same-origin Netlify Function,
ported functionally from `D:\StudioProjects\sci-exchange`. No framework, no
build step.

Pages:

- `/exchange` — converter + "start an order" form (same-origin API, so the
  `connect-src 'self'` CSP stays intact)
- `/orders` — guest order tracking via the id/token link and proof upload
- `/admin` — passcode-gated admin panel (orders, rates, audit log). Not in the
  sitemap and disallowed in `robots.txt`.

Public API (see AGENTS.md for the full route list):

```sh
GET  /api/exchange/rates     # current open state + thbToMmk + mmkToThb
POST /api/exchange/calculate # convert an amount
POST /api/exchange/orders    # start an order  -> id + view token
GET  /api/exchange/orders    # guest list (redacted unless you hold the token)
GET  /api/exchange/orders/{id}?token=...  # detail
POST /api/exchange/orders/{id}/proof      # upload payment proof (JPEG/PNG/WebP)
```

Data lives in Netlify Blobs (`SCI_EXCHANGE_ORDERS` / `SCI_EXCHANGE_PROOFS`).
Deleting a blob store deletes the order history — treat "delete store" with the
same care as `rm -rf`.

Authorization model (matches sci-exchange): order *details* are only served to
someone holding the per-order 48-hex `viewToken`; the admin panel uses a scrypt
passcode at login and a 15-minute HMAC access token afterwards. The honeypot
`company` field is the only success-without-send path, exactly like the
contact form. **Never show "sent" (or "converted") without a server answer** —
re-adding a client-side fill-time gate is both useless and honestly worse than
nothing, because bots see the same pages.

The `@netlify/blobs` dependency is the only item in the root `package.json`.
Netlify installs it automatically for the function; CI runs the tests with the
lazy `Store` stubbed, so no `npm install` is needed there.

## Deploy

Deploys are manual CLI calls (see **Deploying from the CLI** above). The GitHub
repository is deliberately **not** linked to Netlify, so pushing never publishes
anything — do not follow Netlify's "Import an existing project" flow, because
that is what links the repo and turns a push into a deploy.

To publish from a fresh clone:

```sh
netlify login   # once per machine
netlify deploy --dir=site --prod --site 19485f7b-5cc0-426e-a8a0-4ad43a5ea66a
```

The Netlify site itself already exists; nothing here has to be created. What a
deploy does need:

1. In Netlify **Site settings -> Environment variables**, set:

   | Variable | Value |
   | --- | --- |
   | `BREVO_API_KEY` | Brevo v3 API key |
   | `CONTACT_TO` | `contact@skycreation.dev` |
   | `CONTACT_FROM` | a sender address already verified in Brevo (optional) |
   | `EXCHANGE_JWT_SECRET` | random high-entropy string; signs admin access tokens |
   | `EXCHANGE_ADMIN_PASSWORD` | passcode for `/admin` (hashed at rest) |
   | `EXCHANGE_RATE_DEFAULT` | optional; default THB→MMK rate (defaults to 128.5) |

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

2. In Brevo, verify the sending domain so DKIM is signed.
3. In Netlify **Domain settings**, add `skycreation.dev`. Netlify then shows the
   exact apex and `www` records it needs — copy those values into Spaceship
   rather than guessing them, because Netlify's apex record differs by setup.

   Done: apex `A @` → `75.2.60.5`, `CNAME www` → `sky-creation.netlify.app`.
   Keep the existing Spaceship MX/SPF, Brevo DKIM/DMARC records.

   Done: `founder` CNAME → `sky-creation-founder.netlify.app`. Do **not** set
   `founder.skycreation.dev` as a GitHub Pages custom domain on
   `waiyantunoo.github.io` — that redirects every `github.io/*` path onto the
   founder host and breaks the visualiser project sites.

4. Turn off the **Powered by Netlify** badge (company and founder projects):
   Project configuration → General → Powered by Netlify badge → off → Save.
   Already done via API (`built_with_badge_enabled: false`).

### Founder portfolio deploy

Source: `site/founder/`. Netlify site ID `b851f1db-a2f0-4f67-81aa-6798f5296ab6`
(`sky-creation-founder`), custom domain `founder.skycreation.dev`. The command
is in **Deploying from the CLI** above: run it from inside `site/founder` and
always pass `--site`.

**`netlify deploy` has no `--config` flag** (netlify-cli 27.10.2). Older notes
in this repo told you to pass `--config site/founder/netlify.toml`; the CLI
rejects the flag with `unknown option`. Config selection comes from the working
directory, which is why the command `cd`s first. If you find another one-liner
in this repo that passes `--config`, it is broken and has never worked.

Setting the project's **Base directory** to `site/founder` in the Netlify
dashboard makes the same file authoritative for builds started there.

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
- Portfolio address: `site/founder/index.html`, two places — the JSON-LD
  `email` field (a bare address, no `mailto:` prefix, or schema.org rejects it)
  and the visible mailto button. Both are `founder@skycreation.dev`, a verified
  Brevo sender. That page has no form, so no Netlify variable changes with it;
  it needs a founder-site deploy to go live.

Links between pages are root-relative and extensionless (`/about`, not
`/about.html`): Netlify serves both, but only the extensionless form is the
canonical address.

## Licence

MIT. See [LICENSE](LICENSE).
