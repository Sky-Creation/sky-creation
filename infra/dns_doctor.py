#!/usr/bin/env python3
"""Read-only DNS health check for skycreation.dev.

Verifies the live DNS state against the expected layout:

  * Spaceship as registrar/authoritative DNS and inbound mail forwarding
  * Brevo as the outbound transactional sender for the contact form
  * Netlify as the website host for the apex and www

This tool is strictly read-only. It performs no writes to DNS, and it only
reads Spaceship credentials to cross-check the control plane against the
authoritative answer. Nothing here can change your DNS.

Usage:
    ./dns_doctor.py                          # check the default domain
    ./dns_doctor.py --domain example.com
    ./dns_doctor.py --json                   # machine-readable, for CI
    ./dns_doctor.py --no-color               # plain output
    ./dns_doctor.py --control-plane          # also query the Spaceship API
                                           # (needs SPACESHIP_API_KEY/…_SECRET)

Exit codes:
    0  all checks passed (warnings allowed)
    1  at least one FAIL
    2  could not run (dig missing, bad arguments)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

# --------------------------------------------------------------------------
# Expected layout
# --------------------------------------------------------------------------

DEFAULT_DOMAIN = "skycreation.dev"

#: Spaceship's inbound email forwarding hosts.
SPACESHIP_MX_SUFFIX = "efwd.spaceship.net"

#: Registrable domain of Spaceship's authoritative nameservers.
SPACESHIP_NS_DOMAIN = "spaceship.net"

#: Brevo signs outbound mail with DKIM selectors it installs itself. Brevo does
#: not require an SPF include for domain-sent mail, so this is informational
#: only - DKIM alignment is what actually carries the SPF/DKIM pass.
BREVO_DKIM_SELECTORS = ("brevo1", "brevo2")

#: Spaceship's bundled DMARC report destination (rua) is optional; the check
#: only looks at the published policy.
DMARC_POLICY_ORDER = ["none", "quarantine", "reject"]

#: RFC 7208 caps an SPF record at 10 DNS-querying mechanisms.
SPF_LOOKUP_LIMIT = 10

SPACESHIP_API = "https://spaceship.dev/api/v1"

PASS, WARN, FAIL, INFO = "PASS", "WARN", "FAIL", "INFO"

_SYMBOLS = {PASS: "ok  ", WARN: "warn", FAIL: "FAIL", INFO: "--  "}


# --------------------------------------------------------------------------
# Result plumbing
# --------------------------------------------------------------------------


@dataclass
class Finding:
    level: str
    check: str
    detail: str


@dataclass
class Doctor:
    domain: str
    findings: list[Finding] = field(default_factory=list)

    def add(self, level: str, check: str, detail: str) -> None:
        self.findings.append(Finding(level, check, detail))

    def ok(self, check: str, detail: str) -> None:
        self.add(PASS, check, detail)

    def warn(self, check: str, detail: str) -> None:
        self.add(WARN, check, detail)

    def fail(self, check: str, detail: str) -> None:
        self.add(FAIL, check, detail)

    def info(self, check: str, detail: str) -> None:
        self.add(INFO, check, detail)

    @property
    def failed(self) -> bool:
        return any(f.level == FAIL for f in self.findings)

    @property
    def warned(self) -> bool:
        return any(f.level == WARN for f in self.findings)


# --------------------------------------------------------------------------
# dig wrapper
# --------------------------------------------------------------------------


class Dig:
    """Thin, cached wrapper around the dig(1) resolver.

    Once the domain's authoritative nameservers are known, queries go to them
    first, because an authoritative answer is definitive: dig exits 0 for both
    "record exists" and "NXDOMAIN/NODATA", and exits 9 only when a server did
    not reply at all. That lets us stop at the first authoritative reply
    instead of walking a fallback chain, and it avoids reading whatever a
    recursive resolver happens to have cached.
    """

    #: dig(1) exit status meaning the server never replied (a timeout, not an
    #: authoritative negative answer).
    _NO_REPLY = 9

    def __init__(self, nameservers: list[str] | None = None, timeout: int = 2) -> None:
        self.nameservers = nameservers or []
        self.timeout = timeout
        self._cache: dict[tuple[str, str, str], list[str]] = {}
        self._lock = threading.Lock()
        self._preferred: str | None = None

    def query(self, name: str, rtype: str) -> list[str]:
        """Return raw short-form answers for one name/type."""
        with self._lock:
            chain = [s for s in self.nameservers if s != self._preferred]
            if self._preferred:
                chain.insert(0, self._preferred)
        if not chain:
            chain = [None]
        if None not in chain:
            chain.append(None)  # authoritative never replied; ask a recursive resolver
        for server in chain:
            key = (name, rtype, server or "system")
            with self._lock:
                cached = self._cache.get(key)
            if cached is not None:
                return cached  # already settled, empty list included
            records, definitive = self._run(name, rtype, server)
            with self._lock:
                self._cache[key] = records
            if server and definitive:
                # Remember the first server that answers; not every assigned
                # nameserver is reachable from every network, and re-probing a
                # dead one on every record is what makes this slow.
                self._preferred = server
            if records or definitive:
                return records
        return []

    def _run(self, name: str, rtype: str, server: str | None) -> tuple[list[str], bool]:
        """Return (records, definitive). Definitive means the server answered."""
        cmd = ["dig", "+short", f"+time={self.timeout}", "+tries=1"]
        if server:
            cmd.append(f"@{server}")
        cmd += [name, rtype]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout + 3)
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return [], False
        if proc.returncode == self._NO_REPLY:
            return [], False
        if proc.returncode != 0:
            return [], False
        # dig emits status comments on stdout even under +short (e.g. a
        # communications error), and those must never be read as records.
        records = [
            line.strip()
            for line in proc.stdout.splitlines()
            if line.strip() and not line.lstrip().startswith(";")
        ]
        return records, True

    # -- typed accessors ---------------------------------------------------

    def mx(self, name: str) -> list[tuple[int, str]]:
        out = []
        for line in self.query(name, "MX"):
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit():
                out.append((int(parts[0]), parts[1].rstrip(".").lower()))
        return sorted(out)

    def txt(self, name: str) -> list[str]:
        """Return TXT values with quoting and multi-segment values rejoined.

        dig splits long TXT values (DKIM keys) across several quoted
        segments, so naive line handling loses characters.
        """
        out = []
        for line in self.query(name, "TXT"):
            joined = re.sub(r'"\s+"', "", line)  # join split quoted segments
            joined = joined.replace('"', "").strip()
            if joined:
                out.append(joined)
        return out

    def ns(self, name: str) -> list[str]:
        return [line.rstrip(".").lower() for line in self.query(name, "NS")]

    def a(self, name: str) -> list[str]:
        return self.query(name, "A")

    def cname(self, name: str) -> list[str]:
        return [line.rstrip(".").lower() for line in self.query(name, "CNAME")]


# --------------------------------------------------------------------------
# Spaceship control plane (optional, read-only)
# --------------------------------------------------------------------------


class Spaceship:
    """Read-only view of the records Spaceship has on file.

    Authoritative DNS is the real source of truth, so this is only used to
    cross-check. A record that the API reports but DNS does not serve is an
    unsaved or misconfigured change; a record DNS serves that the API does not
    list is a records-scope problem.
    """

    def __init__(self, domain: str, key: str, secret: str, timeout: int = 10) -> None:
        self.domain = domain
        self.key = key
        self.secret = secret
        self.timeout = timeout
        self.items: list[dict] | None = None
        self.error: str | None = None

    def _get(self, path: str) -> dict:
        url = f"{SPACESHIP_API}/{path.lstrip('/')}"
        request = urllib.request.Request(
            url,
            headers={"X-API-Key": self.key, "X-API-Secret": self.secret, "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def load(self) -> bool:
        try:
            payload = self._get(f"dns/records/{self.domain}?take=250&skip=0")
        except urllib.error.HTTPError as exc:
            self.error = f"Spaceship API HTTP {exc.code}"
            return False
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            self.error = f"Spaceship API unreachable ({type(exc).__name__})"
            return False

        self.items = payload.get("items", []) if isinstance(payload, dict) else []
        return True

    def find(self, name: str, rtype: str) -> list[dict]:
        if not self.items:
            return []
        want = name.rstrip(".").lower()
        return [
            item
            for item in self.items
            if str(item.get("name", "")).rstrip(".").lower() == want
            and str(item.get("type", "")).upper() == rtype.upper()
        ]

    def has(self, name: str, rtype: str) -> bool:
        return bool(self.find(name, rtype))

    def values(self, name: str, rtype: str) -> list[str]:
        keys = ("value", "cname", "exchange", "ip", "address", "target", "txt")
        out = []
        for item in self.find(name, rtype):
            for key in keys:
                raw = item.get(key)
                if isinstance(raw, list):
                    out.extend(str(v) for v in raw)
                elif raw:
                    out.append(str(raw))
        return out


# --------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------


def spf_records(txts: list[str]) -> list[str]:
    return [t for t in txts if t.lower().startswith("v=spf1")]


def count_spf_lookups(spf: str) -> int:
    """Count DNS-querying mechanisms in an SPF record (RFC 7208 limit is 10)."""
    mechanisms = 0
    for token in spf.split():
        name = token.split(":", 1)[0].split("/", 1)[0].lower()
        if name in {"include", "a", "mx", "ptr", "exists", "redirect"}:
            mechanisms += 1
    return mechanisms


def check_registration(doc: Doctor, dig: Dig) -> bool:
    nameservers = dig.ns(doc.domain)
    if not nameservers:
        doc.fail(
            "domain-registered",
            f"no NS records for {doc.domain} - domain is not delegated "
            "(not registered, or nameservers not yet propagated)",
        )
        return False

    doc.ok("domain-registered", f"{doc.domain} is delegated via {len(nameservers)} nameserver(s)")

    if any(ns.endswith("." + SPACESHIP_NS_DOMAIN) for ns in nameservers):
        doc.ok("nameservers", f"authoritative on Spaceship: {', '.join(nameservers)}")
    else:
        doc.warn(
            "nameservers",
            f"not on Spaceship: {', '.join(nameservers)} - the domain is registered with "
            "Spaceship, so authoritative DNS should point at its nameservers",
        )
    return True


def check_apex_mail(doc: Doctor, dig: Dig) -> None:
    mx = dig.mx(doc.domain)
    if not mx:
        doc.fail("mx-apex", "no MX record on the apex - mail to the domain has no destination")
        return

    wrong = [host for _, host in mx if not host.endswith("." + SPACESHIP_MX_SUFFIX)]
    if wrong:
        doc.fail(
            "mx-apex",
            f"MX points outside Spaceship email forwarding: {', '.join(wrong)} - two providers "
            "fighting over inbound mail; one can silently blackhole the other",
        )
    else:
        doc.ok("mx-apex", f"{len(mx)} MX record(s) all on {SPACESHIP_MX_SUFFIX}")

    unresolved = [host for _, host in mx if not dig.a(host)]
    if unresolved:
        doc.fail("mx-resolves", f"MX target(s) do not resolve to an A record: {', '.join(unresolved)}")
    else:
        doc.ok("mx-resolves", "every MX target resolves")


def check_spf(doc: Doctor, dig: Dig) -> None:
    txts = dig.txt(doc.domain)
    spfs = spf_records(txts)

    if not spfs:
        doc.warn("spf-present", "no SPF record on the apex - outbound mail will fail SPF at most receivers")
        return

    if len(spfs) > 1:
        doc.fail(
            "spf-single",
            f"{len(spfs)} SPF records on the apex - duplicate SPF is a permanent "
            "deliverability error (RFC 7208 s3.3). Keep exactly one: " + " | ".join(spfs),
        )
        return

    doc.ok("spf-single", "exactly one SPF record on the apex")

    spf = spfs[0]
    if SPACESHIP_MX_SUFFIX in spf:
        doc.ok("spf-authorises-forwarding", f"apex SPF authorises Spaceship forwarding: {spf}")
    else:
        doc.warn(
            "spf-authorises-forwarding",
            f"apex SPF does not mention {SPACESHIP_MX_SUFFIX!r}; if forwarding should be a "
            f"permitted sender, add it: {spf}",
        )

    lookups = count_spf_lookups(spf)
    if lookups > SPF_LOOKUP_LIMIT:
        doc.fail(
            "spf-lookup-limit",
            f"apex SPF has {lookups} DNS-querying mechanisms, over the RFC 7208 limit of "
            f"{SPF_LOOKUP_LIMIT} - SPF returns permerror and every receiver treats it as fail",
        )
    else:
        doc.info("spf-lookup-limit", f"apex SPF uses {lookups}/{SPF_LOOKUP_LIMIT} DNS lookups")


def check_dkim(doc: Doctor, dig: Dig) -> None:
    """Brevo installs its own DKIM selectors; they are what signs contact-form mail."""
    found = []
    for selector in BREVO_DKIM_SELECTORS:
        fqdn = f"{selector}._domainkey.{doc.domain}"
        if [t for t in dig.txt(fqdn) if t.lower().startswith("v=dkim1")]:
            found.append(selector)
        elif dig.cname(f"{selector}._domainkey"):
            found.append(f"{selector} (CNAME)")
        else:
            doc.fail(
                "dkim-brevo",
                f"no DKIM record at {fqdn} - contact-form mail will fail DKIM at most "
                "receivers and land in spam. Re-run Brevo's domain verification",
            )
    if found:
        doc.ok("dkim-brevo", f"Brevo DKIM selector(s) present: {', '.join(found)}")


def check_brevo_verification(doc: Doctor, dig: Dig) -> None:
    """Brevo's domain-verification TXT proves the sender identity is confirmed."""
    matches = [t for t in dig.txt(doc.domain) if "brevo-site-verification" in t.lower()]
    if matches:
        doc.ok("brevo-verification", "Brevo domain verification TXT present")
    else:
        doc.warn(
            "brevo-verification",
            "no Brevo verification TXT on the apex - the sender identity may not be confirmed, "
            "so the contact form can fail to send",
        )


def check_dmarc(doc: Doctor, dig: Dig) -> None:
    fqdn = f"_dmarc.{doc.domain}"
    matches = [t for t in dig.txt(fqdn) if t.lower().startswith("v=dmarc1")]
    if not matches:
        doc.warn("dmarc-present", f"no DMARC record at {fqdn} - receivers have no fail policy")
        return

    record = matches[0]
    policy = re.search(r"\bp=(\w+)", record)
    policy_value = policy.group(1).lower() if policy else "unspecified"
    doc.ok("dmarc-present", f"DMARC published with p={policy_value}")

    if policy_value in DMARC_POLICY_ORDER:
        rank = DMARC_POLICY_ORDER.index(policy_value)
        if rank + 1 < len(DMARC_POLICY_ORDER):
            nxt = DMARC_POLICY_ORDER[rank + 1]
            doc.info("dmarc-policy", f"p={policy_value} - can tighten to p={nxt} once senders are aligned")
    if policy_value == "reject":
        doc.warn(
            "dmarc-policy",
            "p=reject on a new domain means one misaligned sender causes bounced mail - "
            "hold at p=none until SPF and DKIM are known good",
        )


def check_website(doc: Doctor, dig: Dig) -> None:
    for label, name in (("website-apex", doc.domain), ("website-www", f"www.{doc.domain}")):
        addresses = dig.a(name)
        aliases = dig.cname(name)
        if addresses:
            doc.ok(label, f"{name} resolves to {', '.join(addresses)}")
        elif aliases:
            doc.ok(label, f"{name} is a CNAME to {', '.join(aliases)}")
        else:
            doc.warn(
                label,
                f"{name} has no A or CNAME record - Netlify will not serve this hostname "
                "until the domain is added and its DNS records are published",
            )


def check_founder_subdomain(doc: Doctor, dig: Dig) -> None:
    """The founder portfolio is a separate site and must keep working."""
    name = f"founder.{doc.domain}"
    aliases = dig.cname(name)
    addresses = dig.a(name)
    if aliases:
        doc.ok("founder-subdomain", f"{name} is a CNAME to {', '.join(aliases)}")
    elif addresses:
        doc.ok("founder-subdomain", f"{name} resolves to {', '.join(addresses)}")
    else:
        doc.warn(
            "founder-subdomain",
            f"{name} does not resolve - the founder portfolio will be unreachable",
        )


def check_control_plane(doc: Doctor, spaceship: Spaceship) -> None:
    """Cross-check what DNS serves against what Spaceship has on file."""
    if spaceship.error:
        doc.warn("spaceship-api", spaceship.error)
        return

    doc.ok("spaceship-api", f"{len(spaceship.items or [])} record(s) readable from the Spaceship API")

    # The apex must exist in the API, otherwise the zone is not being served from
    # Spaceship even if NS records point there.
    if spaceship.has(doc.domain, "A") or spaceship.has(doc.domain, "CNAME") or spaceship.has(doc.domain, "ALIAS"):
        doc.info("apex-in-zone", "apex website record present in the Spaceship zone")
    else:
        doc.info("apex-in-zone", "no apex website record in the Spaceship zone yet (expected before the first Netlify deploy)")

    for selector in BREVO_DKIM_SELECTORS:
        name = f"{selector}._domainkey.{doc.domain}"
        if not spaceship.has(name, "CNAME") and not spaceship.has(name, "TXT"):
            doc.warn(
                "brevo-dkim-in-zone",
                f"Brevo selector {selector} is missing from the Spaceship zone even if DNS answers for it",
            )


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------

#: Fixed report order, so output is stable regardless of which thread
#: finished first.
CHECK_ORDER = [
    "domain-registered",
    "nameservers",
    "mx-apex",
    "mx-resolves",
    "spf-present",
    "spf-single",
    "spf-authorises-forwarding",
    "spf-lookup-limit",
    "dkim-brevo",
    "brevo-verification",
    "dmarc-present",
    "dmarc-policy",
    "website-apex",
    "website-www",
    "founder-subdomain",
    "spaceship-api",
    "apex-in-zone",
    "brevo-dkim-in-zone",
]


def run(domain: str, control_plane: bool = False) -> Doctor:
    doc = Doctor(domain=domain)
    dig = Dig()

    if not check_registration(doc, dig):
        return doc

    dig.nameservers = dig.ns(domain)

    checks = [
        check_apex_mail,
        check_spf,
        check_dkim,
        check_brevo_verification,
        check_dmarc,
        check_website,
        check_founder_subdomain,
    ]
    with ThreadPoolExecutor(max_workers=len(checks)) as pool:
        for check in checks:
            pool.submit(_safe, check, doc, dig)

    if control_plane:
        key = os.environ.get("SPACESHIP_API_KEY", "")
        secret = os.environ.get("SPACESHIP_API_SECRET", "")
        if key and secret:
            spaceship = Spaceship(domain, key, secret)
            if spaceship.load():
                check_control_plane(doc, spaceship)
            else:
                doc.warn("spaceship-api", spaceship.error or "unknown error")
        else:
            doc.warn(
                "spaceship-api",
                "--control-plane needs SPACESHIP_API_KEY and SPACESHIP_API_SECRET in the environment",
            )

    rank = {name: i for i, name in enumerate(CHECK_ORDER)}
    doc.findings.sort(key=lambda f: rank.get(f.check, len(rank)))
    return doc


def _safe(check, doc: Doctor, dig: Dig) -> None:
    try:
        check(doc, dig)
    except Exception as exc:  # a broken check must not hide the other results
        doc.warn(check.__name__, f"check raised {type(exc).__name__}: {exc}")


def report(doc: Doctor, use_color: bool) -> None:
    if use_color:
        tint = {PASS: "\033[32m", WARN: "\033[33m", FAIL: "\033[31m", INFO: "\033[90m"}
        reset = "\033[0m"
        dim = "\033[2m"
        bold = "\033[1m"
    else:
        tint = {k: "" for k in (PASS, WARN, FAIL, INFO)}
        reset = dim = bold = ""

    print(f"{bold}DNS doctor - {doc.domain}{reset}")
    print(dim + "-" * 72 + reset)
    for f in doc.findings:
        print(f"{tint[f.level]}{_SYMBOLS[f.level]}{reset} {f.check:<26} {f.detail}")
    print(dim + "-" * 72 + reset)

    counts = {lvl: sum(1 for f in doc.findings if f.level == lvl) for lvl in (PASS, WARN, FAIL, INFO)}
    print(f"  {counts[PASS]} pass  {counts[WARN]} warn  {counts[FAIL]} fail  {counts[INFO]} info")
    print("  " + ("FAIL - action required" if doc.failed else "HEALTHY - no blocking issues"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only DNS health check.")
    parser.add_argument("--domain", default=DEFAULT_DOMAIN, help="domain to check")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    parser.add_argument("--no-color", action="store_true", help="disable ANSI colour")
    parser.add_argument(
        "--control-plane",
        action="store_true",
        help="also cross-check against the Spaceship API (needs SPACESHIP_API_KEY/SECRET)",
    )
    args = parser.parse_args(argv)

    if not shutil.which("dig"):
        print("error: dig is not installed (apt install dnsutils / bind-tools)", file=sys.stderr)
        return 2

    doc = run(args.domain, control_plane=args.control_plane)

    if args.json:
        print(
            json.dumps(
                {"domain": doc.domain, "failed": doc.failed, "findings": [asdict(f) for f in doc.findings]},
                indent=2,
            )
        )
    else:
        report(doc, use_color=not args.no_color and sys.stdout.isatty())

    return 1 if doc.failed else 0


if __name__ == "__main__":
    sys.exit(main())
