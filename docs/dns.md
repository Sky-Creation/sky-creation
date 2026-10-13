# DNS monitoring

Purpose: `infra/dns_doctor.py` verifies the live DNS against the expected
layout for skycreation.dev, read-only, and runs nightly in CI.

Read this when: you are touching DNS records, the Spaceship zone, or
`infra/dns_doctor.py` / `infra/test_dns_doctor.py`.

The tool performs **no writes**. It reads Spaceship credentials only for an
optional cross-check. Nothing in it can change DNS.

## Expected layout

| Role | Provider | Records |
| --- | --- | --- |
| Registrar / authoritative DNS | Spaceship | `NS` on `spaceship.net` |
| Inbound mail forwarding | Spaceship | `MX` on `efwd.spaceship.net` |
| Outbound transactional mail | Brevo | DKIM selectors `brevo1`, `brevo2`; verification TXT; DMARC |
| Website host | Netlify | apex `A`, `www` CNAME, `founder` CNAME |

Constants at the top of the file: `DEFAULT_DOMAIN = skycreation.dev`,
`SPACESHIP_MX_SUFFIX = efwd.spaceship.net`,
`SPACESHIP_NS_DOMAIN = spaceship.net`, `BREVO_DKIM_SELECTORS = ("brevo1",
"brevo2")`, `SPF_LOOKUP_LIMIT = 10`, `SPACESHIP_API =
https://spaceship.dev/api/v1`.

## Running

```sh
python infra/dns_doctor.py                    # table (colour on a TTY)
python infra/dns_doctor.py --json             # machine-readable
python infra/dns_doctor.py --no-color         # plain table
python infra/dns_doctor.py --control-plane    # also read the Spaceship API
```

Exit codes: `0` healthy (warnings allowed), `1` at least one FAIL, `2` could not
run (usually `dig` missing). **A non-zero exit is the normal case for a live
domain with warnings.** Do not wrap a `--json` call in a bare `set -e`.

`--control-plane` needs `SPACESHIP_API_KEY` and `SPACESHIP_API_SECRET` in the
environment. Without them it emits a `spaceship-api` WARN.

## The checks

Fixed `CHECK_ORDER`, stable regardless of which thread finished first:

`domain-registered`, `nameservers`, `mx-apex`, `mx-resolves`, `spf-present`,
`spf-single`, `spf-authorises-forwarding`, `spf-lookup-limit`, `dkim-brevo`,
`brevo-verification`, `dmarc-present`, `dmarc-policy`, `website-apex`,
`website-www`, `founder-subdomain`, `spaceship-api`, `apex-in-zone`,
`brevo-dkim-in-zone`.

The DNS checks run concurrently (`ThreadPoolExecutor`); each is wrapped by
`_safe()` so one broken check cannot hide the others.

## `Dig`: zone routing and caching

`Dig` is a thin, cached wrapper around `dig +short`.

- **Route by zone.** `Dig.serves(name)` decides whether the discovered
  authoritative nameservers can answer. In-zone names go to the authoritative
  servers; anything delegated elsewhere goes to a recursive resolver (the
  `None` server in the chain). This is the fix for the worst bug in the project:
  Spaceship is authoritative only for `skycreation.dev`, and asked about
  `b1.skycreation-dev.dkim.brevo.com` it returns nothing — indistinguishable
  from "record missing".
- **Cache only definitive answers.** `_run()` returns `(records, definitive)`.
  dig exit code 9 (`_NO_REPLY`) means the server never replied — a timeout, not
  an authoritative negative. Caching that silence as `[]` made every later query
  settle on "missing" without ever reaching the next server. A timeout is
  re-probed; an authoritative NXDOMAIN still caches.
- **Remember a reachable server.** `_preferred` is set to the first nameserver
  that answers, because not every assigned nameserver is reachable from every
  network.
- `txt()` rejoins multi-segment quoted values (dig splits long DKIM keys).

## DKIM detection and the CNAME chain

`is_dkim_record(txt)` identifies a usable public key by its key type
(`k=rsa`/`ed25519`, defaulting to rsa) and base64 material (`p=` length ≥ 32).
The `v=DKIM1` tag is **optional** per RFC 6376 and **Brevo omits it** — matching
on the tag alone reported working DKIM as missing. An empty `p=` (revoked key)
does not count.

`follow_txt_chain(dig, name, max_hops=5)` walks CNAME delegation to the end.
Brevo publishes a **two-hop** chain:

```
brevo1._domainkey.skycreation.dev
  → b1.skycreation-dev.dkim.brevo.com
    → brevo5.dkim.brevo.com          ← the key is only here
```

Asking an intermediate name for TXT returns the next CNAME, so anything short of
following the whole chain finds nothing.

There were **four** independent faults that each produced a false "DKIM
missing": (1) the required `v=DKIM1` tag, (2) following only one alias,
(3) asking the authoritative servers about the `brevo.com` end, and (4) caching
a timeout as an empty record. All four are fixed and covered by tests.

## Other checks

- **SPF**: exactly one `v=spf1` record; authorises `efwd.spaceship.net`;
  `count_spf_lookups()` counts `< 10` DNS-querying mechanisms.
- **Brevo verification**: a TXT starting `brevo-code:` (the modern form) or the
  legacy `brevo-site-verification=`.
- **DMARC**: policy is read from `p=`; warns on `p=reject` for a young domain
  and suggests tightening `none → quarantine → reject`.
- **Website**: apex and `www` resolve (A or CNAME).
- **Founder**: `founder.<domain>` resolves (CNAME or A).

## Spaceship control plane (optional, read-only)

`Spaceship` reads the zone from the API (`dns/records/<domain>?take=250`) and
cross-checks. Two live-only bugs are baked into it:

- **A real `User-Agent`.** Spaceship sits behind a WAF that answers `403` to the
  default `Python-urllib/x.y` agent. `_get()` sends
  `SPACESHIP_UA = "dns_doctor/1.0 (+https://skycreation.dev)"`.
- **`_normalise()`.** The API reports names **relative to the zone** (`@`,
  `www`, `brevo1._domainkey`), while the checks ask in FQDN form. Both are
  normalised to the zone-relative form before comparison, or every lookup
  silently misses.

Findings: `spaceship-api` (records readable), `apex-in-zone` (informational),
`brevo-dkim-in-zone` (warns if a selector is missing from the zone even if DNS
answers for it).

## The nightly workflow

`.github/workflows/dns-watch.yml` ("DNS watch") runs on `workflow_dispatch` and
the schedule `17 3 * * *` (an off-the-hour minute). It installs `dig`, runs the
doctor, writes `report.json`, and:

- runs the cross-check step **only** when both Spaceship secrets are present
  (`if: env.SPACESHIP_API_KEY != '' && …`);
- on failure (`if: failure()`), opens a tracking issue titled "DNS check failing
  for skycreation.dev", or comments on the existing open one rather than filing a
  duplicate;
- on success (`if: success()`), closes that issue if it is open.

`permissions: contents: read, issues: write`; `concurrency: dns-watch`.
The `check.yml` workflow also smoke-tests that `--json` emits parseable JSON.

## Tests

`infra/test_dns_doctor.py` (48 tests) covers the parsers, not the network:
DKIM detection without the tag, the revoked-key case, the two-hop chain, zone
routing, the timeout-is-not-cached rule, SPF parsing, verification records and
DMARC. Run with `python -m unittest discover -s infra`. See
[`testing.md`](testing.md).

## When to touch what

- Change the expected layout constants (`SPACESHIP_*`, `BREVO_DKIM_SELECTORS`),
  not the check logic, when a provider changes its hostnames.
- If you touch `Dig.query()` or `_query_chain()`, keep the zone split and the
  definitive-only caching.
- If you touch `Spaceship`, keep the explicit `User-Agent` and `_normalise`.
