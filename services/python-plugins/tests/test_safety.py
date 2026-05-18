"""Unit tests for the SSRF guard. No DNS: a fake resolver is injected."""

from __future__ import annotations

import pytest

from app.safety import SafetyPolicy, SSRFError


def fake_resolver(mapping):
    def _resolve(host):
        if host not in mapping:
            raise OSError(f"NXDOMAIN {host}")
        return mapping[host]

    return _resolve


def test_private_ip_blocked():
    pol = SafetyPolicy(
        same_domain_only=False,
        resolver=fake_resolver({"intranet.example.com": ["10.0.0.5"]}),
    )
    with pytest.raises(SSRFError, match="non-public"):
        pol.check_url("http://intranet.example.com/secret")


def test_loopback_blocked():
    pol = SafetyPolicy(
        same_domain_only=False,
        resolver=fake_resolver({"localhost": ["127.0.0.1"]}),
    )
    with pytest.raises(SSRFError, match="non-public"):
        pol.check_url("http://localhost:8080/admin")


def test_literal_loopback_ip_blocked():
    pol = SafetyPolicy(same_domain_only=False, resolver=fake_resolver({}))
    with pytest.raises(SSRFError):
        pol.check_url("http://127.0.0.1/")


def test_link_local_blocked():
    pol = SafetyPolicy(
        same_domain_only=False,
        resolver=fake_resolver({"meta.example.com": ["169.254.169.254"]}),
    )
    with pytest.raises(SSRFError, match="non-public"):
        pol.check_url("http://meta.example.com/latest/meta-data")


def test_ipv4_mapped_ipv6_private_blocked():
    pol = SafetyPolicy(
        same_domain_only=False,
        resolver=fake_resolver({"sneaky.example.com": ["::ffff:10.0.0.1"]}),
    )
    with pytest.raises(SSRFError):
        pol.check_url("http://sneaky.example.com/")


def test_disallowed_domain_blocked():
    pol = SafetyPolicy(
        same_domain_only=False,
        allowed_domains=["example.com"],
        resolver=fake_resolver({"evil.test": ["93.184.216.34"]}),
    )
    with pytest.raises(SSRFError, match="allowedDomains"):
        pol.check_url("http://evil.test/")


def test_allowed_domain_subdomain_ok():
    pol = SafetyPolicy(
        same_domain_only=False,
        allowed_domains=["example.com"],
        resolver=fake_resolver({"docs.example.com": ["93.184.216.34"]}),
    )
    assert pol.check_url("https://docs.example.com/page") == (
        "https://docs.example.com/page"
    )


def test_non_http_scheme_blocked():
    pol = SafetyPolicy(same_domain_only=False, resolver=fake_resolver({}))
    for url in ("file:///etc/passwd", "ftp://x/y", "gopher://h/", "data:text/x"):
        with pytest.raises(SSRFError, match="scheme"):
            pol.check_url(url)


def test_missing_host_blocked():
    pol = SafetyPolicy(same_domain_only=False, resolver=fake_resolver({}))
    with pytest.raises(SSRFError, match="missing host"):
        pol.check_url("http:///nohost")


def test_allow_private_networks_bypass():
    pol = SafetyPolicy(
        same_domain_only=False,
        allow_private_networks=True,
        resolver=fake_resolver({"intranet.local": ["10.1.2.3"]}),
    )
    assert pol.check_url("http://intranet.local/") == "http://intranet.local/"


def test_same_domain_only_enforced():
    pol = SafetyPolicy(
        same_domain_only=True,
        resolver=fake_resolver(
            {
                "site.com": ["93.184.216.34"],
                "sub.site.com": ["93.184.216.34"],
                "other.com": ["93.184.216.34"],
            }
        ),
    ).seed_from(["https://site.com/start"])
    assert pol.check_url("https://site.com/a") == "https://site.com/a"
    assert pol.check_url("https://sub.site.com/b") == "https://sub.site.com/b"
    with pytest.raises(SSRFError, match="sameDomainOnly"):
        pol.check_url("https://other.com/c")


def test_dns_failure_blocked():
    pol = SafetyPolicy(same_domain_only=False, resolver=fake_resolver({}))
    with pytest.raises(SSRFError, match="DNS resolution failed"):
        pol.check_url("http://does-not-exist.example/")


def test_multi_record_any_private_blocked():
    # Public + private mix must be rejected (DNS-rebinding style bypass).
    pol = SafetyPolicy(
        same_domain_only=False,
        resolver=fake_resolver(
            {"mixed.example.com": ["93.184.216.34", "127.0.0.1"]}
        ),
    )
    with pytest.raises(SSRFError, match="non-public"):
        pol.check_url("http://mixed.example.com/")


def test_filter_urls_drops_bad_keeps_good():
    pol = SafetyPolicy(
        same_domain_only=False,
        resolver=fake_resolver(
            {"good.com": ["93.184.216.34"], "bad.com": ["10.0.0.1"]}
        ),
    )
    out = pol.filter_urls(
        ["https://good.com/1", "https://bad.com/2", "ftp://good.com/3"]
    )
    assert out == ["https://good.com/1"]
