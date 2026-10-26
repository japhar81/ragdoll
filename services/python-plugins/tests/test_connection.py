"""Tests for ADR-0039 external-connection support in the sidecar.

Covers three seams:

  * the Connect bridge decoding ``ExecuteRequest.connection`` (a
    google.protobuf.Struct) into the typed ``ExternalConnection`` pydantic
    model — both the present and the absent cases;
  * ``ExternalConnection.fresh_credential`` choosing between the inline
    credential and a grant-driven refresh based on expiry + skew;
  * the low-level ``refresh_credential`` HTTP helper.

No real network: every HTTP round-trip goes through an in-process fake client
that records the POST and returns a canned response. The fakes implement only
the slice of httpx's API the helper touches (``post`` / ``aclose`` / a response
with ``status_code`` + ``json()``).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import pytest

from app.connect_bridge import _proto_to_pydantic
from app.connection_refresh import needs_refresh, refresh_credential
from app.models import ExternalConnection, RefreshGrant
from ragdoll_plugin_py.proto.plugin_pb2 import ExecuteRequest as ProtoExecuteRequest


# A fixed clock so expiry math is deterministic regardless of wall time.
NOW = datetime(2026, 10, 26, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
class _FakeResponse:
    """Minimal stand-in for httpx.Response (status_code + json())."""

    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Any:
        return self._payload


class _FakeAsyncClient:
    """Records the single POST and returns a canned response. No network."""

    def __init__(self, response: _FakeResponse) -> None:
        self._response = response
        self.calls: List[Tuple[str, Optional[Dict[str, Any]]]] = []
        self.closed = False

    async def post(self, url: str, json: Optional[Dict[str, Any]] = None) -> _FakeResponse:
        self.calls.append((url, json))
        return self._response

    async def aclose(self) -> None:
        self.closed = True


class _ExplodingClient:
    """A client whose POST raises — proves the no-refresh paths never call it."""

    async def post(self, url: str, json: Optional[Dict[str, Any]] = None):
        raise AssertionError(f"unexpected refresh POST to {url} with {json!r}")


def _proto_request_with_connection(connection: Dict[str, Any]) -> ProtoExecuteRequest:
    """Build a proto ExecuteRequest whose `connection` Struct is populated.

    Mutating the sub-message accessor marks the field present, so
    `HasField('connection')` is True — the condition the bridge gates on.
    """
    req = ProtoExecuteRequest(plugin="cartography_crawl", version="1.0.0", node_id="n1")
    req.connection.update(connection)
    return req


# --------------------------------------------------------------------------- #
# (a) bridge maps a connection Struct -> req.connection
# --------------------------------------------------------------------------- #
def test_proto_to_pydantic_maps_connection():
    req = _proto_request_with_connection(
        {
            "slug": "my-api",
            "kind": "http",
            "options": {"baseUrl": "https://api.example.com"},
            "credential": {
                "value": "inline-token",
                "headers": {"X-Api-Key": "k"},
                "query": {"api_key": "k"},
                "expiresAt": "2026-10-26T13:00:00Z",
                "options": {"scope": "read"},
            },
            "refresh": {
                "url": "https://core.example.com/refresh",
                "token": "grant-tok",
                "expiresAt": "2026-10-26T18:00:00Z",
            },
        }
    )
    assert req.HasField("connection")

    py = _proto_to_pydantic(req)

    conn = py.connection
    assert isinstance(conn, ExternalConnection)
    assert conn.slug == "my-api"
    assert conn.kind == "http"
    assert conn.options == {"baseUrl": "https://api.example.com"}

    assert conn.credential is not None
    # The headline requirement: the inline credential value is readable.
    assert conn.credential.value == "inline-token"
    assert conn.credential.headers == {"X-Api-Key": "k"}
    assert conn.credential.query == {"api_key": "k"}
    # camelCase `expiresAt` from core binds to the camelCase field.
    assert conn.credential.expiresAt == "2026-10-26T13:00:00Z"
    assert conn.credential.options == {"scope": "read"}

    assert conn.refresh is not None
    assert conn.refresh.url == "https://core.example.com/refresh"
    assert conn.refresh.token == "grant-tok"
    assert conn.refresh.expiresAt == "2026-10-26T18:00:00Z"


def test_proto_to_pydantic_accepts_snake_case_expires_at():
    """A transport that preserves proto field names (snake_case) still binds."""
    req = _proto_request_with_connection(
        {
            "slug": "s",
            "kind": "http",
            "credential": {"value": "v", "expires_at": "2026-10-26T13:00:00Z"},
        }
    )
    py = _proto_to_pydantic(req)
    assert py.connection.credential.expiresAt == "2026-10-26T13:00:00Z"


# --------------------------------------------------------------------------- #
# (b) no connection -> req.connection is None
# --------------------------------------------------------------------------- #
def test_proto_to_pydantic_no_connection():
    req = ProtoExecuteRequest(plugin="cartography_crawl", version="1.0.0", node_id="n1")
    assert not req.HasField("connection")

    py = _proto_to_pydantic(req)
    assert py.connection is None


# --------------------------------------------------------------------------- #
# needs_refresh unit coverage (the decision function)
# --------------------------------------------------------------------------- #
def test_needs_refresh_no_expiry_is_static():
    assert needs_refresh(None, now=NOW) is False
    assert needs_refresh("", now=NOW) is False


def test_needs_refresh_future_beyond_skew():
    assert needs_refresh("2026-10-26T13:00:00Z", now=NOW, skew_seconds=60) is False


def test_needs_refresh_within_skew_window():
    # 30s out, 60s skew -> inside the window -> refresh.
    assert needs_refresh("2026-10-26T12:00:30Z", now=NOW, skew_seconds=60) is True


def test_needs_refresh_already_expired():
    assert needs_refresh("2026-10-26T11:00:00Z", now=NOW) is True


def test_needs_refresh_unparseable_refreshes():
    assert needs_refresh("not-a-timestamp", now=NOW) is True


# --------------------------------------------------------------------------- #
# (c) fresh_credential: inline vs. refresh
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_fresh_credential_returns_inline_when_not_expiring():
    conn = ExternalConnection(
        slug="s",
        kind="http",
        credential={"value": "inline", "expiresAt": "2026-10-26T13:00:00Z"},
        refresh={"url": "https://core/refresh", "token": "rt"},
    )
    cred = await conn.fresh_credential(now=NOW, client=_ExplodingClient())
    # Unchanged inline credential, and crucially no POST happened.
    assert cred is conn.credential
    assert cred.value == "inline"


@pytest.mark.asyncio
async def test_fresh_credential_static_no_expiry_returns_inline():
    conn = ExternalConnection(
        slug="s",
        kind="http",
        credential={"value": "static-key"},  # no expiresAt
        refresh={"url": "https://core/refresh", "token": "rt"},
    )
    cred = await conn.fresh_credential(now=NOW, client=_ExplodingClient())
    assert cred.value == "static-key"


@pytest.mark.asyncio
async def test_fresh_credential_no_grant_returns_inline_even_if_expired():
    conn = ExternalConnection(
        slug="s",
        kind="http",
        credential={"value": "stale", "expiresAt": "2020-01-01T00:00:00Z"},
        refresh=None,
    )
    # No grant -> nothing to refresh; no client needed.
    cred = await conn.fresh_credential(now=NOW)
    assert cred.value == "stale"


@pytest.mark.asyncio
async def test_fresh_credential_refreshes_when_within_skew():
    conn = ExternalConnection(
        slug="s",
        kind="http",
        credential={"value": "old", "expiresAt": "2026-10-26T12:00:30Z"},
        refresh={"url": "https://core/refresh", "token": "grant-tok"},
    )
    fake = _FakeAsyncClient(
        _FakeResponse(
            200,
            {"credential": {"value": "new", "expiresAt": "2026-10-26T14:00:00Z"}},
        )
    )
    cred = await conn.fresh_credential(now=NOW, client=fake)

    # POSTed the grant token to the grant URL.
    assert fake.calls == [("https://core/refresh", {"token": "grant-tok"})]
    # Returned the minted credential, and swapped it in place on the connection.
    assert cred.value == "new"
    assert cred.expiresAt == "2026-10-26T14:00:00Z"
    assert conn.credential.value == "new"
    # A caller-supplied client is not closed by the helper.
    assert fake.closed is False


@pytest.mark.asyncio
async def test_fresh_credential_refreshes_when_absent():
    conn = ExternalConnection(
        slug="s",
        kind="http",
        credential=None,  # nothing inline — must fetch via the grant
        refresh={"url": "https://core/refresh", "token": "grant-tok"},
    )
    fake = _FakeAsyncClient(_FakeResponse(200, {"credential": {"value": "minted"}}))
    cred = await conn.fresh_credential(now=NOW, client=fake)
    assert fake.calls == [("https://core/refresh", {"token": "grant-tok"})]
    assert cred.value == "minted"


# --------------------------------------------------------------------------- #
# refresh_credential (low-level helper)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_refresh_credential_posts_token_and_returns_credential():
    grant = RefreshGrant(url="https://core/refresh", token="grant-tok")
    fake = _FakeAsyncClient(
        _FakeResponse(200, {"credential": {"value": "fresh", "headers": {"A": "b"}}})
    )
    out = await refresh_credential(grant, client=fake)
    assert fake.calls == [("https://core/refresh", {"token": "grant-tok"})]
    assert out == {"value": "fresh", "headers": {"A": "b"}}


@pytest.mark.asyncio
async def test_refresh_credential_raises_on_non_2xx():
    grant = RefreshGrant(url="https://core/refresh", token="rt")
    fake = _FakeAsyncClient(_FakeResponse(500, {"error": "boom"}))
    with pytest.raises(ValueError, match="HTTP 500"):
        await refresh_credential(grant, client=fake)


@pytest.mark.asyncio
async def test_refresh_credential_raises_on_missing_credential():
    grant = RefreshGrant(url="https://core/refresh", token="rt")
    fake = _FakeAsyncClient(_FakeResponse(200, {"not_credential": {}}))
    with pytest.raises(ValueError, match="missing a 'credential'"):
        await refresh_credential(grant, client=fake)
