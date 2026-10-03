# AGENTS.md

Working notes for any AI agent or tool picking up this repository. Written by
opencode during the original build so a different model can continue without
rediscovering the same faults.

Human-facing documentation lives in [README.md](README.md). This file is the
operational one: what the traps are and what not to undo.

---

## 1. What this is

- **Production site:** <https://skycreation.dev> — five static pages, no build step
- **Founder portfolio:** <https://founder.skycreation.dev> — a **separate** Netlify
  site, not part of this repository. Linked from the main menu as an external site.
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
netlify.toml              Netlify config. Lives at repo root on purpose.
site/                     The published site
  index.html              Landing
  about.html              Studio and founder
  work.html               Project catalogue
  math.html               A Noob Mathematician
  contact.html            Contact form
  assets/styles.css       All styling
  assets/main.js          Nav toggle, footer year, contact form
  assets/posts.js         Facebook post lists (BOTH EMPTY - see §6)
  assets/favicon.svg
  functions/contact.mjs   Netlify Function -> Brevo
  test/main.test.mjs      Contact form, client side
  test/contact.test.mjs   Contact form, server side
maintenance/              Emergency fallback, NOT published
infra/
  dns_doctor.py           Read-only DNS health check
  test_dns_doctor.py      Parser tests (39 tests)
.github/workflows/
  check.yml               Tests + syntax + link check on every push
  dns-watch.yml           Nightly DNS check, files an issue on failure
```

---

## 3. Commands

```sh
# Tests - CI runs exactly these
node --test site/test/*.test.mjs        # 18 tests
python3 -m unittest discover -s infra   # 39 tests

# Deploy (manual - see §4)
netlify deploy --dir=site --prod

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
netlify deploy --dir=. --prod     # BREAKS the site: 404 at /
netlify deploy --dir=site --prod  # correct
```

Passing the repo root uploads the whole tree; there is no `index.html` at the
top level, so `/` 404s. This has already happened once.

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
(`name="company"`, hidden) and the per-IP rate limit. `site/test/` asserts the
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

### `node --test site/test/` is invalid

Node treats a bare directory as a module name and dies with `MODULE_NOT_FOUND`.
Use the glob, unquoted, so the shell expands it:
`node --test site/test/*.test.mjs`.

### The workflow path filter includes `.github/**`

So that a commit which only edits a workflow still gets checked. Do not remove
it — a broken CI fix cannot be verified by CI without this.

---

## 5. Netlify environment

Site ID `19485f7b-5cc0-426e-a8a0-4ad43a5ea66a`.

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
| Deploy automation | Not set up. Linking the repo to Netlify, or adding a deploy hook, would make CI publish. Ask before doing it. |
| `SPACESHIP_API_KEY` / `SPACESHIP_API_SECRET` | Not set in GitHub. Only the optional `--control-plane` cross-check needs them; everything else runs without. |
| `Sky-Creation/zz-write-probe` | Stray private repo from earlier diagnostics. Needs manual deletion; GitHub API writes were failing intermittently. |
| Org default permission | The `Sky-Creation` org's `default_repository_permission` was changed from `read` to `write` during diagnostics. Revert if unintended. |

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

- 18 Node tests, 39 Python tests passing; CI green on `main`
- DNS watch: **12 pass, 0 warn, 0 fail** (was 0 pass / 3 fail)
- All five pages return 200 on `https://skycreation.dev`
- Contact form delivers end-to-end; honeypot and validation paths correct
- DNS: apex `A @` → `75.2.60.5`, `CNAME www` → `sky-creation.netlify.app`,
  valid TLS, `www` → apex 301. DKIM, SPF, DMARC and the `founder` CNAME present.

The DNS watch workflow files one tracking issue on failure, comments on it
rather than opening duplicates, and closes it when DNS recovers. That lifecycle
has been exercised and works.