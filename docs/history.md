# Build history

Purpose: a chronological record of what was built, when, and — more usefully —
*why* each change was made. Most entries exist to stop a future maintainer
reintroducing a bug that already cost time once.

Read this when: you want to know why something is the way it is, or you are
about to undo a strange-looking decision.

Format: each entry is `date — hash — why it mattered`. Run `git show <hash>` to
see the change itself. This file is **append-only**; add new phases at the
bottom, never rewrite the past.

The project went from an empty repository to the live site, the SCI Exchange
app and a site-wide admin panel in roughly two weeks across eight phases.

---

## Phase 0 — Foundations (2026-09-30)

The first site, the contact form and the DNS monitor all landed on day one.

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `d936e56` | 2026-09-30 | Initial commit: the static site, the Brevo contact function and the Spaceship DNS monitor. The architecture chosen here (static site + one function + nightly DNS check) never changed. |
| `cf8db89` | 2026-09-30 | The two CI workflows: a nightly DNS check and a push-time link/syntax check. |
| `8adf3f9` | 2026-09-30 | A "coming soon" maintenance page plus a redirect to the founder portfolio — the emergency takedown switch. |
| `5a4e22a` | 2026-09-30 | Keep the contact function deployed while the maintenance page is published, so a takedown does not silently kill the form. |

Design decision fixed here for good: **no build step, no framework, no
dependencies** except the single `@netlify/blobs` package the exchange would
later need.

---

## Phase 1 — Truth-telling and the DNS false alarms (2026-10-03)

The hardest stretch of the project. Two unrelated problems surfaced the same
day: the contact form claimed success without sending, and DNS monitoring
reported working mail as broken.

### 1a — "Never show sent without a send"

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `9f45f61` | 2026-10-03 | Removed the client- and server-side "minimum fill time" gate. It showed "Message sent" without calling the API when the page was under ~1.2 s old, so real enquiries from autofill/password managers were silently lost — and it never stopped bots, because it trusted a caller-supplied timestamp. The honeypot (`company`) and the per-IP rate limit are the defences that actually work. |

This is the origin of the project's most-repeated rule and the reason `test/`
asserts that a fast submission *must* send. See
[`contact.md`](contact.md) and [`decisions.md`](decisions.md).

### 1b — "The DNS monitor was crying wolf"

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `e488bee` | 2026-10-03 | First fix for the false "DKIM missing" reports. The parser required records to start with `v=DKIM1`, but that tag is optional (RFC 6376) and Brevo omits it — its records start `k=rsa;p=...`. |
| `307e1ff` | 2026-10-03 | Follow DKIM through the CNAME Brevo actually publishes. |
| `e9674c8` | 2026-10-03 | Follow the **whole** CNAME chain, not just the first hop. Brevo's chain is two hops: `brevo1._domainkey` → `b1.…dkim.brevo.com` → `brevo5.dkim.brevo.com`, and only the last name holds the key. |
| `bd255da` | 2026-10-03 | **The real fix.** Stop asking the domain's own authoritative servers (Spaceship) about names in `brevo.com`; they know nothing about them and return nothing, which is indistinguishable from "record missing". Names are now routed by zone: in-zone → authoritative, everything else → recursive resolver. |
| `7dff0cd` | 2026-10-03 | Recognise the Brevo verification record actually published (`brevo-code:<hash>`) instead of an older string style. |
| `2e1c248` | 2026-10-03 | Make the checks that should have caught this run — the smoke test had been skipping them. |
| `4d664ce` | 2026-10-03 | Stop the JSON smoke test failing when the doctor legitimately exits non-zero (a live domain with warnings). |

The `71e98fb`, `0040031`, `a72809e`, `55e939d` commits are temporary `dig`
probes from the debugging session; they were reverted. They are left in the
history on purpose, as a record of what the live DNS actually answered.

### 1c — Publishing the real site

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `1e01658` | 2026-10-03 | Publish the real site (switch off the maintenance page). |
| `7dad9dc` | 2026-10-03 | Fix the test command CI actually runs. |
| `ac5577c` | 2026-10-03 | Run site checks when the workflows themselves change — hence `.github/**` in the `check.yml` path filter. |
| `79ef8f2` | 2026-10-03 | Remove dead code and inline styles; inline `style` attributes are banned, styling lives in `assets/styles.css`. |
| `f53249e` | 2026-10-03 | Make the documentation describe the site that is actually live. |

---

## Phase 2 — Founder portfolio in-repo and the Pages trap (2026-10-03)

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `99f4713` | 2026-10-03 | Move the founder portfolio into this repository (`site/founder/`) and harden the company site. It stays a **separate** Netlify site. |
| `ae9192a` | 2026-10-03 | Add the founder portfolio to the main menu. |
| `99f4713`/`18c7e49` | 2026-10-03 | Document the founder cutover and the GitHub Pages custom-domain trap: `founder.skycreation.dev` must **not** be set as a custom domain on `waiyantunoo.github.io`, or every `github.io/*` path (including the maths visualiser project sites) gets redirected onto the founder host. |
| `8ecc776` | 2026-10-03 | Note that the org default repository permission was reverted to `read` (it had been temporarily `write` during diagnostics). |
| `947dc30` | 2026-10-03 | Add the mailto fallback and link the live maths visualisers. |
| `e0942ca` | 2026-10-03 | Write down what another agent needs so it does not undo the work — the seed of `AGENTS.md`. |

---

## Phase 3 — Stop publishing sources, and the design upgrade (2026-10-05)

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `8acd427` | 2026-10-05 | **Stop publishing the tests and the contact function as static files.** With `publish = "site"`, everything under `site/` is uploaded and served. `/functions/contact.mjs` had been serving the source, disclosing the honeypot field name (`company`), the rate-limit numbers and the Brevo wiring — and honeypot detection only works if the attacker does not know the field name. `test/` and `functions/` now live at the repo root, and `/test/*` + `/functions/*` deny rules are belt-and-suspenders. |
| `c1a555e` | 2026-10-05 | Point the syntax and test steps at the moved directories. |
| `5461438` | 2026-10-05 | Design upgrade matching the founder portfolio. |
| `485b24c` | 2026-10-05 | Fix a JS early return that killed scroll animations on non-contact pages. |
| `c1fb4d4` | 2026-10-05 | Fix a missing space in "Sky Creation Innovations". |
| `96e286a` | 2026-10-05 | Expand the SkyAdmin Pro description. |

---

## Phase 4 — CI gates and the first exchange app (2026-10-09)

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `5555850` | 2026-10-09 | Block `netlify deploy` on test failure — deploys now run the suites first and fail if they do not pass. |
| `747db1f` | 2026-10-09 | Enforce strict DNS control-plane cross-checking: remove `continue-on-error`, so a control-plane disagreement fails the run and files a tracking issue. |
| `a3d10f8` | 2026-10-09 | UI/UX and interactivity pass (filters, canvas, copy toast, status badges). |
| `a2155ee`, `9e393ef` | 2026-10-09 | Multi-format tab favicons (ico/png/svg/apple-touch), with cache-busting. |
| `4f90310` | 2026-10-09 | First interactive SCI Exchange calculator at `/app`. |
| `6ebee85`, `cf26451` | 2026-10-09 | Simplify the converter UI; force zero-cache styling via embedded styles and headers. |
| `60a1b7c` | 2026-10-09 | Direct `/exchange` URL, manual rate editing, admin auto-rate controls, deep-link generation. |
| `7dd1513` | 2026-10-09 | Fix the rate input width. |

The `/app` page from this phase was later retired (see Phase 6) because it was
a duplicate of `/exchange` and the two drifted.

---

## Phase 5 — CI polish (2026-10-11)

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `28d613a` | 2026-10-11 | Bump `checkout` and `setup-node` actions to v5. |
| `ae4ce35` | 2026-10-11 | Pin runners to `ubuntu-24.04`; gate the Spaceship cross-check behind the secrets being present. |
| `5eb3a2b` | 2026-10-11 | Silence upstream git and npm noise in workflow logs (the `init.defaultBranch` config trick). |

---

## Phase 6 — SCI Exchange port and the Blobs consistency saga (2026-10-11)

The largest single piece of work: porting the `sci-exchange` app to a
same-origin Netlify Function backed by Netlify Blobs.

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `70773a7` | 2026-10-11 | Port SCI Exchange to a same-origin Netlify Function. |
| `347f29d` | 2026-10-11 | Install the exchange function dependency before bundling (`@netlify/blobs` is the only root dependency; esbuild will not install for it). |
| `3d7eb6c` | 2026-10-11 | Drop the retired `/app` duplicate. |
| `25f9ac2` | 2026-10-11 | **Configure Blobs for Lambda-style handlers via `connectLambda`.** v1 handlers do not get the Blobs environment injected; without it the first store open dies with `getEnvironmentContext2 is not a function`. |
| `cc628c2` | 2026-10-11 | Temporary echo of the live function event shape (debug; reverted by `37373ef`). |
| `f50efc6` | 2026-10-11 | **Stop reading every blob as JSON text.** `@netlify/blobs` `get()` returns JSON *text* unless given `{ type: 'json' }`, so every order read as a string, `viewToken` never matched and redaction never lifted. Fixed by the `JsonStore` wrapper. |
| `37373ef` | 2026-10-11 | Drop the debug echo; document the deployed reality. |
| `b1c4016` | 2026-10-11 | Open the blob store strongly consistent, fix the list contract. |
| `778567c` | 2026-10-11 | Pass strong consistency inside `getStore`'s options object. |
| `cb8c33d` | 2026-10-11 | **Survive Blobs eventual consistency in v1 functions.** Strong consistency is *unavailable* in v1 (the SDK routes strong reads through an `uncachedEdgeURL` that `connectLambda` never receives), so the app became append-only for anything read by prefix listing, and admin transitions re-read once after 250 ms before reporting a state conflict. |
| `faa8d56` | 2026-10-11 | Read old index sentinels as inert, never as data (the `order:index`, `rate:history:index`, `audit:index` keys were removed). |
| `6b5587b` | 2026-10-11 | Document the completed exchange admin pass and the Blobs consistency fix. |

The `InMemoryStore` used by tests is strong by construction, which is exactly
why the 99 in-memory tests never showed any of these bugs. See
[`exchange.md`](exchange.md).

---

## Phase 7 — Site-wide admin panel and the audit (2026-10-13)

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `e84962f` | 2026-10-13 | Land the site-wide admin panel and fix the audit findings. Split the backend: `exchange.mjs` serves only public `/api/exchange/*`; `admin.mjs` owns all `/api/admin/*` plus the public `/api/posts`; both call the shared `createOrderStore` core. |
| `d2fff9c` | 2026-10-13 | Record the panel as live; ignore the seed output (`seed-admin-out.json`). |

The panel (username-or-email login, dashboard, exchange orders/rates, posts
editor, settings, audit list, account) was live-verified end to end on
`skycreation.dev`.

---

## Phase 8 — DNS control-plane cross-check enabled (2026-10-13)

| Hash | Date | Why it mattered |
| --- | --- | --- |
| `8ee530f` | 2026-10-13 | Give the Spaceship API call a real `User-Agent`. Spaceship's WAF answers `403` to the default `Python-urllib/x.y` agent, so the cross-check failed before it started. |
| `d359428` | 2026-10-13 | Match Spaceship zone names *relative*, not as FQDNs. The API returns zone-relative names (`@`, `brevo1._domainkey`); comparing whole FQDNs missed every record. |
| `eff9d4e` | 2026-10-13 | Record the cross-check as live and clean. |

Final `dns-watch` result with both fixes: **13 pass, 0 warn, 0 fail, 3 info.**

---

## Where things stand

At the end of Phase 8 the project is feature-complete for its current scope:

- Company site and founder portfolio live.
- Contact form, exchange storefront and site-wide admin panel live.
- DNS monitoring with a strict Spaceship control-plane cross-check.
- 103 Node tests and 48 Python tests passing in CI.

The next work, if any, is listed under "Open work" in [`../AGENTS.md`](../AGENTS.md).
