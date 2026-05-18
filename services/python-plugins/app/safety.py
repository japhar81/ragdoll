"""SSRF guard and crawl-limit helpers.

This module is intentionally pure and dependency-free (stdlib only) so it can be
fully unit-tested offline. DNS resolution is injected via a ``resolver``
callable so tests never touch the network.

This is a multi-tenant crawler, so the default posture is *deny*: private,
loopback, link-local, reserved and multicast destinations are blocked unless a
tenant explicitly opts in via ``allowPrivateNetworks``.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass, field
from typing import Callable, Iterable, List, Optional
from urllib.parse import urlsplit

# A resolver maps a hostname to a list of IP-address strings. The default uses
# the system resolver; tests inject a fake.
Resolver = Callable[[str], List[str]]

ALLOWED_SCHEMES = ("http", "https")


class SSRFError(ValueError):
    """Raised when a URL is rejected by the SSRF guard.

    Subclasses ``ValueError`` so the request handler's generic ValueError ->
    ``{"error": ...}`` mapping also covers SSRF rejections.
    """


def system_resolver(host: str) -> List[str]:
    """Resolve ``host`` to a list of IP strings using the OS resolver.

    Returns every A/AAAA record so we can reject hosts where *any* resolved
    address is unsafe (a common DNS-rebinding / multi-record bypass).
    """
    infos = socket.getaddrinfo(host, None)
    addrs: List[str] = []
    for info in infos:
        sockaddr = info[4]
        ip = sockaddr[0]
        if ip not in addrs:
            addrs.append(ip)
    return addrs


def _is_blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    """True if the IP falls into any range we never crawl by default."""
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        # IPv4-mapped / 6to4 / Teredo wrappers can smuggle private v4 space.
        or (isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None
            and _is_blocked_ip(ip.ipv4_mapped))
    )


def _host_matches_domain(host: str, domain: str) -> bool:
    """Case-insensitive host == domain or host is a subdomain of domain."""
    host = host.lower().rstrip(".")
    domain = domain.lower().rstrip(".")
    return host == domain or host.endswith("." + domain)


@dataclass
class SafetyPolicy:
    """Per-execution crawl policy derived from plugin ``config``."""

    allow_private_networks: bool = False
    allowed_domains: List[str] = field(default_factory=list)
    same_domain_only: bool = True
    max_pages: int = 10
    max_depth: int = 1
    timeout_ms: int = 60_000
    # Defaults to None so the module-level ``system_resolver`` is looked up
    # dynamically at call time (lets tests monkeypatch safety.system_resolver
    # or pass an explicit fake). Tests usually inject their own fake here.
    resolver: Optional[Resolver] = None
    # Set of registrable hosts the crawl started from; populated by
    # ``seed_from`` and used to enforce ``same_domain_only``.
    seed_hosts: List[str] = field(default_factory=list)

    def seed_from(self, urls: Iterable[str]) -> "SafetyPolicy":
        """Record the hostnames of the seed URLs for same-domain checks."""
        for u in urls:
            host = urlsplit(u).hostname
            if host:
                h = host.lower()
                if h not in self.seed_hosts:
                    self.seed_hosts.append(h)
        return self

    def check_url(self, url: str) -> str:
        """Validate a single URL. Returns the URL on success, else raises.

        Checks, in order: scheme, host present, allowedDomains allowlist,
        sameDomainOnly, then DNS resolution + IP-range deny list.
        """
        parts = urlsplit(url)
        scheme = (parts.scheme or "").lower()
        if scheme not in ALLOWED_SCHEMES:
            raise SSRFError(
                f"blocked URL {url!r}: scheme {scheme or '(none)'!r} not allowed "
                f"(only {'/'.join(ALLOWED_SCHEMES)})"
            )

        host = parts.hostname
        if not host:
            raise SSRFError(f"blocked URL {url!r}: missing host")
        host_l = host.lower()

        if self.allowed_domains:
            if not any(_host_matches_domain(host_l, d) for d in self.allowed_domains):
                raise SSRFError(
                    f"blocked URL {url!r}: host {host_l!r} not in allowedDomains"
                )

        if self.same_domain_only and self.seed_hosts:
            if not any(
                _host_matches_domain(host_l, seed) for seed in self.seed_hosts
            ):
                raise SSRFError(
                    f"blocked URL {url!r}: host {host_l!r} violates sameDomainOnly"
                )

        # A literal IP host skips DNS but still must pass the range check.
        literal_ip: Optional[ipaddress._BaseAddress] = None
        try:
            literal_ip = ipaddress.ip_address(host_l.strip("[]"))
        except ValueError:
            literal_ip = None

        if literal_ip is not None:
            addrs = [str(literal_ip)]
        else:
            resolver = self.resolver or system_resolver
            try:
                addrs = resolver(host_l)
            except Exception as exc:  # noqa: BLE001 - resolution failure is fatal
                raise SSRFError(
                    f"blocked URL {url!r}: DNS resolution failed for {host_l!r}: {exc}"
                ) from exc
            if not addrs:
                raise SSRFError(
                    f"blocked URL {url!r}: no addresses resolved for {host_l!r}"
                )

        if not self.allow_private_networks:
            for addr in addrs:
                try:
                    ip = ipaddress.ip_address(addr)
                except ValueError:
                    raise SSRFError(
                        f"blocked URL {url!r}: invalid resolved address {addr!r}"
                    )
                if _is_blocked_ip(ip):
                    raise SSRFError(
                        f"blocked URL {url!r}: resolves to non-public address "
                        f"{addr!r} (set config.allowPrivateNetworks to override)"
                    )

        return url

    def filter_urls(self, urls: Iterable[str]) -> List[str]:
        """Return only the URLs that pass ``check_url`` (silently drops bad)."""
        ok: List[str] = []
        for u in urls:
            try:
                ok.append(self.check_url(u))
            except SSRFError:
                continue
        return ok
