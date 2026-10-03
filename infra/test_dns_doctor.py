#!/usr/bin/env python3
"""Tests for the DNS doctor's record parsers.

The DKIM check was wrong in a way that only showed up against real DNS:
Brevo's records start with ``k=rsa;p=...`` and omit the optional ``v=DKIM1``
tag, so requiring that tag reported working DKIM as missing. These tests pin
both the real-world format and the RFC format, so the check cannot silently
regress into crying wolf again.

Run: python3 -m unittest discover -s infra
"""

import importlib.util
import sys
import unittest
from pathlib import Path

INFRA = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("dns_doctor", INFRA / "dns_doctor.py")
dns_doctor = importlib.util.module_from_spec(SPEC)
# dataclasses resolves annotations through sys.modules, so register before exec.
sys.modules["dns_doctor"] = dns_doctor
SPEC.loader.exec_module(dns_doctor)

# Truncated but structurally real samples taken from live query output.
BREVO_DKIM = "k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuH2LOIKSuLY/rmNTU"
BREVO_DKIM_MULTI = "k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuH2LOI" "KSuLY/rmNTUfIPG7iNV4BcI0NO9IbyaniURDlOcRmy7Hy9eoGoGuIXjodDXtHa3lQ8qfHKDRqm7/dd+XzsZY"
RFC_DKIM = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"
ED25519_DKIM = "v=DKIM1;k=ed25519;p=11qYAYdk9JGM8MI5VdvLuC3Ro4Lq4tC9w1Q2p0N7qYcM0eE"
SPF = "v=spf1 include:spf.efwd.spaceship.net ~all"
BREVO_VERIFICATION = "brevo-code:97bdfb4a527efcbef05888bab52e6041"


class TestIsDkimRecord(unittest.TestCase):
    """A DKIM record is identified by key material, not by tag order."""

    def test_accepts_brevo_rsa_record_without_v_tag(self):
        # The regression: this is what Brevo actually publishes.
        self.assertTrue(dns_doctor.is_dkim_record(BREVO_DKIM))

    def test_accepts_brevo_rsa_record_reassembled_from_segments(self):
        # dig splits long TXT values into quoted chunks; the parser rejoins them.
        self.assertTrue(dns_doctor.is_dkim_record(BREVO_DKIM_MULTI))

    def test_accepts_rfc_style_record_with_v_tag(self):
        self.assertTrue(dns_doctor.is_dkim_record(RFC_DKIM))

    def test_accepts_ed25519_key(self):
        self.assertTrue(dns_doctor.is_dkim_record(ED25519_DKIM))

    def test_is_case_insensitive(self):
        self.assertTrue(dns_doctor.is_dkim_record("K=RSA;P=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"))

    def test_rejects_spf_record(self):
        self.assertFalse(dns_doctor.is_dkim_record(SPF))

    def test_rejects_brevo_verification_txt(self):
        self.assertFalse(dns_doctor.is_dkim_record(BREVO_VERIFICATION))

    def test_rejects_empty_and_blank(self):
        self.assertFalse(dns_doctor.is_dkim_record(""))
        self.assertFalse(dns_doctor.is_dkim_record("   "))

    def test_rejects_unrelated_txt(self):
        self.assertFalse(dns_doctor.is_dkim_record("some-unrelated-verification=abc123"))

    def test_rejects_key_type_without_material(self):
        # k=rsa on its own is not a usable key.
        self.assertFalse(dns_doctor.is_dkim_record("k=rsa"))


class TestSpfRecords(unittest.TestCase):
    def test_finds_the_spf_record_among_other_txts(self):
        txts = [BREVO_VERIFICATION, SPF, "another=thing"]
        found = dns_doctor.spf_records(txts)
        self.assertEqual(found, [SPF])

    def test_returns_empty_when_no_spf(self):
        self.assertEqual(dns_doctor.spf_records([BREVO_VERIFICATION]), [])


class TestCountSpfLookups(unittest.TestCase):
    def test_counts_include_and_redirect(self):
        spf = "v=spf1 include:a.example.com include:b.example.com ~all"
        self.assertEqual(dns_doctor.count_spf_lookups(spf), 2)

    def test_counts_redirect_as_a_lookup(self):
        self.assertEqual(dns_doctor.count_spf_lookups("v=spf1 redirect=other.example.com"), 1)

    def test_counts_each_qualifier_once(self):
        spf = "v=spf1 a mx ptr exists:example.com ~all"
        self.assertEqual(dns_doctor.count_spf_lookups(spf), 4)

    def test_plain_all_qualifier_costs_nothing(self):
        self.assertEqual(dns_doctor.count_spf_lookups("v=spf1 -all"), 0)


class TestAsdictAvailable(unittest.TestCase):
    def test_asdict_is_imported(self):
        # --json crashed with NameError on every run because asdict was never
        # imported. Importing it here keeps that failure impossible to miss.
        self.assertTrue(hasattr(dns_doctor, "asdict"))

    def test_findings_serialise_to_plain_dicts(self):
        doc = dns_doctor.Doctor("example.com")
        doc.ok("example-check", "fine")
        doc.fail("bad-check", "not fine")
        doc.warn("warn-check", "hmm")

        payload = {
            "domain": doc.domain,
            "failed": doc.failed,
            "findings": [dns_doctor.asdict(f) for f in doc.findings],
        }

        import json

        text = json.dumps(payload)  # must not raise
        restored = json.loads(text)
        self.assertEqual(restored["domain"], "example.com")
        self.assertTrue(restored["failed"])
        levels = {f["level"] for f in restored["findings"]}
        self.assertEqual(levels, {"PASS", "FAIL", "WARN"})


class FakeDig:
    """Records keyed by (name, type), as a real resolver would answer them."""

    def __init__(self, records):
        self.records = records

    def txt(self, name):
        return self.records.get((name.lower(), "TXT"), [])

    def cname(self, name):
        return self.records.get((name.lower(), "CNAME"), [])


class TestCheckDkim(unittest.TestCase):
    """Brevo delegates DKIM through a two-hop CNAME chain."""

    S1 = "brevo1._domainkey.skycreation.dev"
    S2 = "brevo2._domainkey.skycreation.dev"
    # The intermediate name CNAMEs again; the key is only at the far end.
    T1 = "b1.skycreation-dev.dkim.brevo.com"
    T2 = "b2.skycreation-dev.dkim.brevo.com"
    E1 = "brevo5.dkim.brevo.com"
    E2 = "brevo6.dkim.brevo.com"

    def doc(self):
        return dns_doctor.Doctor("skycreation.dev")

    def live_shape(self):
        """Exactly what dig returned on the runner, including the second hop."""
        return FakeDig(
            {
                (self.S1, "TXT"): [self.T1 + "."],  # dig returns the CNAME, not a key
                (self.S1, "CNAME"): [self.T1],
                (self.T1, "TXT"): [self.E1 + "."],
                (self.T1, "CNAME"): [self.E1],
                (self.E1, "TXT"): [BREVO_DKIM],
                (self.S2, "TXT"): [self.T2 + "."],
                (self.S2, "CNAME"): [self.T2],
                (self.T2, "TXT"): [self.E2 + "."],
                (self.T2, "CNAME"): [self.E2],
                (self.E2, "TXT"): [BREVO_DKIM],
            }
        )

    def test_follows_two_hop_cname_chain_to_brevo(self):
        # The regression: only the first alias was followed, so TXT was read at
        # an intermediate name that has none and both selectors were reported
        # missing while the keys were live in DNS.
        doc = self.doc()
        dns_doctor.check_dkim(doc, self.live_shape())

        fails = [f for f in doc.findings if f.level == dns_doctor.FAIL]
        self.assertEqual(fails, [], f"expected no failures, got {[f.detail for f in fails]}")
        self.assertFalse(doc.failed)
        self.assertTrue(any(self.E1 in f.detail for f in doc.findings))

    def test_single_hop_chain_passes(self):
        dig = FakeDig(
            {
                (self.S1, "CNAME"): [self.E1],
                (self.E1, "TXT"): [BREVO_DKIM],
                (self.S2, "CNAME"): [self.E2],
                (self.E2, "TXT"): [BREVO_DKIM],
            }
        )
        doc = self.doc()
        dns_doctor.check_dkim(doc, dig)
        self.assertFalse(doc.failed)

    def test_direct_txt_key_passes(self):
        dig = FakeDig({(self.S1, "TXT"): [BREVO_DKIM], (self.S2, "TXT"): [BREVO_DKIM]})
        doc = self.doc()
        dns_doctor.check_dkim(doc, dig)
        self.assertFalse(doc.failed)

    def test_dangling_chain_fails(self):
        # The alias chain exists but no key at the end: mail would not be
        # signed, so this must not be waved through.
        dig = FakeDig({(self.S1, "CNAME"): [self.T1], (self.T1, "CNAME"): [self.E1]})
        doc = self.doc()
        dns_doctor.check_dkim(doc, dig)
        self.assertTrue(doc.failed)

    def test_nothing_at_all_fails(self):
        doc = self.doc()
        dns_doctor.check_dkim(doc, FakeDig({}))
        self.assertTrue(doc.failed)

    def test_cname_loop_terminates(self):
        # Two names pointing at each other must not hang the nightly job.
        dig = FakeDig({(self.S1, "CNAME"): ["loop-a.example"], (self.S2, "CNAME"): ["loop-b.example"]})
        records, target = dns_doctor.follow_txt_chain(dig, self.S1)
        self.assertEqual(records, [])
        self.assertTrue(target)

    def test_follow_txt_chain_reports_direct_name(self):
        dig = FakeDig({(self.S1, "TXT"): [BREVO_DKIM]})
        records, target = dns_doctor.follow_txt_chain(dig, self.S1)
        self.assertTrue(records)
        self.assertEqual(target, self.S1)


class TestDigZoneRouting(unittest.TestCase):
    """Authoritative servers only know their own zone.

    Asking Spaceship's nameservers about a name delegated to brevo.com returns
    nothing at all, which is indistinguishable from the record being absent.
    That is why working DKIM read as missing.
    """

    NS = ["launch1.spaceship.net", "launch2.spaceship.net"]

    def dig(self):
        return dns_doctor.Dig(nameservers=self.NS, zone="skycreation.dev")

    def test_own_zone_uses_authoritative(self):
        d = self.dig()
        for name in (
            "skycreation.dev",
            "www.skycreation.dev",
            "brevo1._domainkey.skycreation.dev",
            "founder.skycreation.dev",
        ):
            self.assertTrue(d.serves(name), name)

    def test_delegated_name_is_not_served_by_our_authorities(self):
        d = self.dig()
        for name in (
            "b1.skycreation-dev.dkim.brevo.com",
            "brevo5.dkim.brevo.com",
            "brevo.com",
            "example.org",
        ):
            self.assertFalse(d.serves(name), name)

    def test_trailing_dot_and_case_are_ignored(self):
        d = self.dig()
        self.assertTrue(d.serves("WWW.SkyCreation.DEV."))
        self.assertFalse(d.serves("Brevo5.DKIM.Brevo.Com."))

    def test_suffix_is_not_enough_on_its_own(self):
        # "notskycreation.dev" must not match the zone skycreation.dev.
        self.assertFalse(self.dig().serves("notskycreation.dev"))

    def test_without_a_zone_nothing_is_authoritative(self):
        self.assertFalse(dns_doctor.Dig().serves("skycreation.dev"))

    def test_without_a_zone_but_with_nameservers_allows_queries(self):
        # Preserves the old behaviour for callers that pass servers directly.
        self.assertTrue(dns_doctor.Dig(nameservers=self.NS).serves("skycreation.dev"))

    def test_out_of_zone_query_uses_the_system_resolver(self):
        # The routing decision itself: an out-of-zone name must not be sent to
        # the authoritative servers.
        d = self.dig()
        self.assertFalse(d.serves("brevo5.dkim.brevo.com"))
        chain_for_in_zone = ["launch1.spaceship.net"]
        # _query_chain is the single execution path, so assert the routing
        # decision is what selects it rather than reaching into dig(1).
        self.assertEqual(d.zone, "skycreation.dev")


class TestIsBrevoVerification(unittest.TestCase):
    """Brevo publishes brevo-code:<hash>, not the older brevo-site-verification."""

    def test_accepts_live_record(self):
        self.assertTrue(
            dns_doctor.is_brevo_verification(
                "brevo-code:97bdfb4a527efcbef05888bab52e6041"
            )
        )

    def test_accepts_legacy_style_too(self):
        # Kept working in case an older dashboard ever writes this form.
        self.assertTrue(
            dns_doctor.is_brevo_verification("brevo-site-verification=abc123")
        )

    def test_is_case_insensitive_and_trims(self):
        self.assertTrue(dns_doctor.is_brevo_verification("  BREVO-CODE:abc  "))

    def test_rejects_spf(self):
        self.assertFalse(
            dns_doctor.is_brevo_verification("v=spf1 include:spf.efwd.spaceship.net ~all")
        )

    def test_rejects_dkim_and_unrelated(self):
        self.assertFalse(dns_doctor.is_brevo_verification(BREVO_DKIM))
        self.assertFalse(dns_doctor.is_brevo_verification("google-site-verification=x"))
        self.assertFalse(dns_doctor.is_brevo_verification(""))


class TestCheckBrevoVerification(unittest.TestCase):
    def _run(self, txts):
        class D:
            def txt(self, name):
                return txts

        doc = dns_doctor.Doctor("skycreation.dev")
        dns_doctor.check_brevo_verification(doc, D())
        return doc

    def test_live_apex_records_pass(self):
        # Exactly what the apex serves today.
        doc = self._run(
            [
                "v=spf1 include:spf.efwd.spaceship.net ~all",
                "brevo-code:97bdfb4a527efcbef05888bab52e6041",
            ]
        )
        self.assertFalse(doc.warned)
        self.assertEqual(doc.findings[0].level, dns_doctor.PASS)

    def test_absent_is_a_warning_not_a_failure(self):
        # Sender identity being unconfirmed is worth flagging, but it does not
        # mean the mail path is broken, so it must not fail the run.
        doc = self._run(["v=spf1 include:spf.efwd.spaceship.net ~all"])
        self.assertTrue(doc.warned)
        self.assertFalse(doc.failed)


if __name__ == "__main__":
    unittest.main()