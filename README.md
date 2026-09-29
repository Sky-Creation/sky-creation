# skycreation.dev

Official website for **Sky Creation Innovations**, plus the DNS tooling that
keeps the domain healthy.

- Live site: <https://skycreation.dev>
- Founder portfolio (separate site, not part of this repo): <https://founder.skycreation.dev>

Everything here is free-tier only: Netlify for hosting, Brevo for the contact
form, GitHub Actions for DNS monitoring, Spaceship for DNS.

## Layout

```
netlify.toml                        Netlify build config (root, so it is found)
maintenance/                        Published directory while the site is being finished
  index.html                        "Coming soon" page
  assets/favicon.svg
site/                               The finished site (not published yet)
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
infra/
  dns_doctor.py                     Read-only DNS health check
.github/workflows/
  dns-watch.yml                     Nightly DNS check
  check.yml                         Syntax + link check on every push
```

There is no build step. Edit a file, push, Netlify redeploys.

## Which site is live

`netlify.toml` sets `publish = "maintenance"`, so the live site is the
"coming soon" page and every other address redirects to
[founder.skycreation.dev](https://founder.skycreation.dev).

To publish the finished site instead, change one line:

```toml
publish = "site"
```

and delete the `[[redirects]]` block in the same file. The redirect rules
currently sit after the publish setting, so a stale copy is harmless, but
removing it keeps the config honest.

The contact function stays deployed either way, so the mail path is live and
testable while the rest of the site waits. The maintenance page has no form,
so `/api/contact` is reachable but nothing on the page submits to it.

### Deploying from the CLI

`--dir` overrides `[build] publish`. Passing the repository root uploads the
whole tree and the site 404s at `/`, because there is no `index.html` at the
top level. Point `--dir` at the directory you actually want published:

```sh
netlify deploy --dir=maintenance --prod     # the coming-soon page
netlify deploy --dir=site --prod            # the finished site
```

The functions directory still comes from `netlify.toml`, so the contact
function is deployed with either command.

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
   Keep the existing Spaceship MX/SPF, Brevo DKIM/DMARC, and `founder` CNAME
   records.

## DNS monitoring

`infra/dns_doctor.py` is read-only. It resolves records with `dig`, preferring
the domain's own authoritative nameservers, and checks:

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

The scheduled workflow runs nightly and on demand from the Actions tab. It
needs the same two Spaceship secrets under **Settings -> Secrets and variables
-> Actions**.

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
- Contact addresses: `site/contact.html` and the `CONTACT_TO` / `CONTACT_FROM`
  Netlify variables — keep the visible address and the receiving address
  consistent, otherwise mail will be sent to somewhere nobody reads.

## Licence

MIT. See [LICENSE](LICENSE).
