"""Refresh a node's external-connection credential via its revocable grant.

ADR-0039: core resolves a node's external connection and ships it to the
sidecar on ``ExecuteRequest.connection`` — a materialised credential plus an
optional ``refresh`` grant. The grant is a short-lived, server-revocable
``{url, token}`` pair; when the inline credential nears expiry the sidecar
POSTs ``{"token": <grant token>}`` to ``url`` (JSON) and core responds with
``{"credential": {<ExternalCredential shape>}}``. Because the grant is
revocable, a leaked sidecar can't keep minting credentials once core revokes
it.

Design notes
------------
* **Dependency-light.** ``httpx`` is already a dependency the codebase uses, so
  we reuse it rather than add a new HTTP client — but we import it *lazily*,
  only on the default-client path. ``app.models`` imports nothing from here at
  module load, and this module imports nothing heavy at load, so neither import
  pulls httpx in. A caller that supplies its own ``client`` never triggers the
  httpx import at all.
* **Injectable client.** Every entry point takes an optional ``client`` so the
  HTTP round-trip can be mocked in unit tests with no real network. The mock
  only needs ``.post(url, json=...) -> response`` where ``response`` has a
  ``status_code`` int and a ``json()`` method — the same subset of httpx's API
  we rely on.
* **Status handling by code, not exception class.** We check ``status_code``
  directly instead of calling httpx's ``raise_for_status`` so a plain mock
  response works without emulating httpx's exception hierarchy.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.models import RefreshGrant


def parse_iso8601(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp, tolerating a trailing ``Z``.

    Returns ``None`` when ``value`` is empty or unparseable rather than
    raising — callers treat an unparseable expiry as "better refresh than
    trust it." Naive datetimes (no offset) are returned as-is; the caller
    normalises them to UTC.
    """
    if not value:
        return None
    try:
        text = value.strip()
        # Python 3.11's fromisoformat handles most offsets but historically
        # choked on a bare 'Z'; normalise it so older/stricter builds agree.
        if text.endswith("Z") or text.endswith("z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text)
    except (ValueError, AttributeError):
        return None


def needs_refresh(
    expires_at: Optional[str],
    *,
    now: Optional[datetime] = None,
    skew_seconds: int = 60,
) -> bool:
    """Decide whether a credential with ``expires_at`` should be refreshed now.

    * No ``expires_at`` → ``False`` (static credential, never expires).
    * Unparseable ``expires_at`` → ``True`` (don't trust an expiry we can't read).
    * Otherwise → ``True`` iff the expiry is at or before ``now + skew_seconds``.

    ``now`` defaults to the current UTC time. Both the expiry and ``now`` are
    coerced to UTC when they arrive naive so the comparison can't raise on a
    naive/aware mismatch.
    """
    if not expires_at:
        return False
    expiry = parse_iso8601(expires_at)
    if expiry is None:
        return True
    if now is None:
        now = datetime.now(timezone.utc)
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return expiry <= now + timedelta(seconds=skew_seconds)


async def refresh_credential(
    refresh: "RefreshGrant",
    *,
    client: Optional[Any] = None,
) -> dict:
    """POST the refresh grant and return the freshly minted credential dict.

    POSTs ``{"token": refresh.token}`` to ``refresh.url`` as JSON. Raises
    ``ValueError`` on any non-2xx response or a malformed body (missing
    ``credential`` object). Returns the parsed ``credential`` dict — the caller
    coerces it into an ``ExternalCredential``.

    When ``client`` is ``None`` a short-lived ``httpx.AsyncClient`` is created
    and closed around the single call; pass a shared client to avoid per-call
    connection setup.
    """
    owns_client = client is None
    if owns_client:
        import httpx  # lazy: only the default path needs httpx installed

        client = httpx.AsyncClient()
    try:
        response = await client.post(refresh.url, json={"token": refresh.token})
    finally:
        if owns_client:
            await client.aclose()

    status = getattr(response, "status_code", None)
    if status is None or not (200 <= int(status) < 300):
        raise ValueError(
            f"connection refresh failed: POST {refresh.url} returned HTTP {status}"
        )

    payload = response.json()
    credential = payload.get("credential") if isinstance(payload, dict) else None
    if not isinstance(credential, dict):
        raise ValueError(
            "connection refresh response missing a 'credential' object "
            f"(got keys: {sorted(payload) if isinstance(payload, dict) else type(payload).__name__})"
        )
    return credential
