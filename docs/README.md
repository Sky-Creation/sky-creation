# skycreation.dev documentation

Purpose: the index for every guide and the build history in this folder.

Read this when: you are new to the repository, or you know what you need and
want the one file that covers it.

Three layers of documentation exist, and they do different jobs:

| Layer | File(s) | Job |
| --- | --- | --- |
| Operational, terse | [`../AGENTS.md`](../AGENTS.md) | The "do not break these" rules and current state. The single most important file. Read it first. |
| Human overview | [`../README.md`](../README.md) | What the site is, who hosts it, how to run it. |
| Guides + history | this folder | How each subsystem works, step-by-step how-tos, and why every decision was made. |

If the three ever disagree, `AGENTS.md` is authoritative about the present,
and [`history.md`](history.md) is authoritative about the past.

## Start here

1. [`../AGENTS.md`](../AGENTS.md) — the traps. Do this before touching anything.
2. [`architecture.md`](architecture.md) — how a request flows through the site.
3. [`setup.md`](setup.md) — get a working local checkout.
4. The subsystem guide for the thing you are about to change.

## Read this when…

| You want to… | Read |
| --- | --- |
| Know how the pieces fit together | [`architecture.md`](architecture.md) |
| Set up or run the project locally | [`setup.md`](setup.md) |
| Publish, roll back, or take the site down | [`deploy.md`](deploy.md) |
| Fix something in production right now | [`runbook.md`](runbook.md) |
| Run or add tests | [`testing.md`](testing.md) |
| Change the contact form | [`contact.md`](contact.md) |
| Change the SCI Exchange storefront | [`exchange.md`](exchange.md) |
| Change the admin panel | [`admin.md`](admin.md) |
| Touch DNS or the DNS monitor | [`dns.md`](dns.md) |
| Change CI or the deploy pipeline | [`ci-cd.md`](ci-cd.md) |
| Know why a decision was made | [`decisions.md`](decisions.md) — or browse [`history.md`](history.md) |
| Handle a credential | [`secrets.md`](secrets.md) |
| Understand how the project got here | [`history.md`](history.md) |

## What the project is

- **Company site** — <https://skycreation.dev>. Six static pages, a contact
  form, and the SCI Exchange app. No framework, no bundler, no build step.
- **Founder portfolio** — <https://founder.skycreation.dev>. Source lives in
  `site/founder/` in the same repository, but is a separate Netlify site.
- **DNS tooling** — `infra/dns_doctor.py`, run nightly by GitHub Actions.
- **Admin panel** — `site/admin.html` + `functions/admin.mjs`, a same-origin
  password panel for the exchange, the Facebook post lists and the audit log.

Everything runs on free tiers: Netlify (hosting + Functions + Blobs), Brevo
(contact-form mail), GitHub Actions (CI + DNS monitoring), Spaceship (DNS).

## Conventions used in these docs

- British spelling, matching the surrounding code and `AGENTS.md`.
- Code paths are written from the repository root (`functions/admin.mjs`).
- Commit references are `hash` plus a date, so a reader can `git show` them.
- No credentials, tokens or hashes appear in these files. Env-var *names* do;
  see [`secrets.md`](secrets.md) for where the values live.
- Guides link to `AGENTS.md` rather than repeating its rules, so there is one
  place to update when a rule changes.

## Maintaining this folder

- Add a subsystem guide when you add a subsystem; add the row to the table
  above and to the "Read this when…" table.
- Keep `history.md` append-only. Add a phase or an entry, do not rewrite the
  past; the commit cited is the source of truth.
- Keep `decisions.md` as short "decision / why / alternative rejected" notes.
- If a fact here contradicts `AGENTS.md`, `AGENTS.md` wins and this folder is
  the thing to fix.
