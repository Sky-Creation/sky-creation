# AGENTS.md

Working notes for any AI agent or tool picking up this repository. Written by
opencode during the original build so a different model can continue without
rediscovering the same faults.

Human-facing documentation lives in [README.md](README.md). This file is the
operational one: what the traps are and what not to undo.

---

## 1. What this is

- **Production site:** <https://skycreation.dev> — five static pages, no build step
- **Founder portfolio:** <https://founder.skycreation.dev> — source in
  `site/founder/`, separate Netlify site (same repo). Linked from the main menu
  as an external subdomain. Formerly hosted on GitHub Pages
  (`waiyantunoo.github.io`); keep that Pages site only as a redirect after DNS
  points `founder` at Netlify.
- **Hosting:** Netlify (free tier, manually deployed)
- **Contact form:** Netlify Function → Brevo
- **DNS:** Spaceship, monitored nightly by GitHub Actions

Vanilla HTML/CSS/JS. No framework, no bundler, no package.json. Do not introduce
one without asking.

### Current state

The real site is published. `maintenance/` is retained but **deliberately not
published** — it is the emergency takedown switch, nothing more.

---

## 2. Layout

```
netlify.toml              Company-site Netlify config. Lives at repo root on purpose.
functions/                Netlify Function -> Brevo. NOT under site/, never published
  contact.mjs
test/                     Node tests. NOT under site/, never published
  main.test.mjs           Contact form, client side
  contact.test.mjs        Contact form, server side
site/                     Company site publish root
  index.html              Landing
  about.html              Studio and founder
  work.html               Project catalogue
  math.html               A Noob Mathematician
  contact.html            Contact form
  404.html                Real 404 page, and the target of the deny rules
  robots.txt, sitemap.xml
  assets/styles.css       All styling
  assets/main.js          Nav toggle, footer year, contact form
  assets/posts.js         Facebook post lists (BOTH EMPTY - see §6)
  assets/favicon.svg
  founder/                Founder portfolio publish root (separate Netlify site)
maintenance/              Emergency fallback, NOT published
infra/
  dns_doctor.py           Read-only DNS health check
  test_dns_doctor.py      Parser tests (39 tests)
.github/workflows/
  check.yml               Tests + syntax + link check on every push
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
node --test test/*.test.mjs             # 23 tests
python3 -m unittest discover -s infra   # 39 tests

# Deploy (manual - see §4)
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

### Deploys are manual

**Pushing does not publish anything.** The GitHub repo is *not* linked to
Netlify. Every deploy is an explicit CLI call. Do not tell anyone that a push
deployed the site.

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

Already set on the live site.

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
| Deploy automation | Not set up. Linking the repo to Netlify, or adding a deploy hook, would make CI publish. Ask before doing it. |
| `SPACESHIP_API_KEY` / `SPACESHIP_API_SECRET` | **Still not in Actions** (`gh secret list` is empty). `dns-watch.yml` already references them behind `continue-on-error: true`, so the cross-check step is skipped rather than failing. Needs the keys rotated and set as repo secrets. |
| `Sky-Creation/zz-write-probe` | **Done.** Deleted; `gh repo view` no longer resolves it. |
| Org default permission | Reverted to `read` (was temporarily `write` during diagnostics). Re-verified as `read`. |

**Unverified claim:** Brevo returns `{"ok":true}` and accepts mail, but Netlify's
log API is not available with the current token, so honeypot discards have never
been confirmed to appear in logs. Worth checking in the Netlify dashboard.

---

## 7. Conventions

- British spelling in prose ("behaviour", "recognise"); match the surrounding text
- Plain ES5-ish JavaScript, no build step, no dependencies
- Commit messages explain **why**, not what. Several here document a bug that
  would otherwise be reintroduced. Keep that up.
- Tests are expected for anything touching the contact form or DNS parsers.
  Both were wrong for a long time precisely because nothing ran.
- CSS lives in `site/assets/styles.css`. Inline `style` attributes were removed
  deliberately; use the existing classes or add a rule.

---

## 8. Verified state at handoff

- 23 Node tests, 39 Python tests passing; CI green on `main`
- DNS watch: **12 pass, 0 warn, 0 fail** (was 0 pass / 3 fail)
- All five pages return 200 on `https://skycreation.dev`
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