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
    """Brevo delegates DKIM by CNAME, so the key is only at the far end."""

    S1 = "brevo1._domainkey.skycreation.dev"
    S2 = "brevo2._domainkey.skycreation.dev"
    T1 = "b1.skycreation-dev.dkim.brevo.com"
    T2 = "b2.skycreation-dev.dkim.brevo.com"

    def doc(self):
        return dns_doctor.Doctor("skycreation.dev")

    def both(self):
        """Both selectors delegated, which is how Brevo publishes them."""
        return FakeDig(
            {
                (self.S1, "CNAME"): [self.T1],
                (self.T1, "TXT"): [BREVO_DKIM],
                (self.S2, "CNAME"): [self.T2],
                (self.T2, "TXT"): [BREVO_DKIM],
            }
        )

    def test_follows_cname_to_brevo_and_passes(self):
        # This is the live shape: no TXT at the selector, a CNAME, and the key
        # published at the alias target. The check previously failed here.
        doc = self.doc()
        dns_doctor.check_dkim(doc, self.both())

        fails = [f for f in doc.findings if f.level == dns_doctor.FAIL]
        self.assertEqual(fails, [], f"expected no failures, got {[f.detail for f in fails]}")
        self.assertFalse(doc.failed)
        self.assertTrue(any(self.T1 in f.detail for f in doc.findings))

    def test_direct_txt_key_passes(self):
        dig = FakeDig({(self.S1, "TXT"): [BREVO_DKIM], (self.S2, "TXT"): [BREVO_DKIM]})
        doc = self.doc()
        dns_doctor.check_dkim(doc, dig)
        self.assertFalse(doc.failed)

    def test_cname_present_but_target_has_no_key_fails(self):
        # A dangling alias is not a working signature; it must still be a FAIL
        # rather than being waved through because a CNAME exists.
        dig = FakeDig({(self.S1, "CNAME"): [self.T1]})
        doc = self.doc()
        dns_doctor.check_dkim(doc, dig)
        self.assertTrue(doc.failed)

    def test_nothing_at_all_fails(self):
        doc = self.doc()
        dns_doctor.check_dkim(doc, FakeDig({}))
        self.assertTrue(doc.failed)


if __name__ == "__main__":
    unittest.main()