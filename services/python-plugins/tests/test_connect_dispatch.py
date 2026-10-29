"""The Connect bridge must run blocking plugin handlers OFF the event loop.

Every plugin handler is a blocking, synchronous call (subprocess shell-outs,
a child-process crawl, CPU-bound model inference). If the async Execute path
called one directly it would pin Hypercorn's single event loop for the whole
crawl, so ``/healthz`` could not answer and the liveness probe would restart
the container mid-crawl. ``app.connect_bridge._run_handler`` dispatches the
handler via ``asyncio.to_thread`` to prevent exactly that.

These tests pin that guarantee: the handler runs on a different thread, the
event loop keeps making progress while the handler blocks, and handler
exceptions still propagate so the caller's error mapping is unaffected.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from app.connect_bridge import _run_handler


# The request is opaque to _run_handler — it only forwards it to the handler —
# so a sentinel keeps these tests free of the full ExecuteRequest scaffolding.
_REQ = object()


@pytest.mark.asyncio
async def test_run_handler_executes_off_the_event_loop_thread() -> None:
    loop_thread = threading.get_ident()
    seen: dict[str, int] = {}

    def handler(_req: object) -> dict:
        seen["thread"] = threading.get_ident()
        return {"outputs": {"ok": True}}

    result = await _run_handler(handler, _REQ)  # type: ignore[arg-type]

    assert result == {"outputs": {"ok": True}}
    # Proof of the fix: the blocking handler ran on a worker thread, not the
    # event-loop thread.
    assert seen["thread"] != loop_thread


@pytest.mark.asyncio
async def test_event_loop_stays_responsive_while_a_handler_blocks() -> None:
    proceed = threading.Event()
    loop_ran = False

    def blocking_handler(_req: object) -> dict:
        # Block until the concurrent coroutine has run. If the handler were
        # executed ON the event loop, `proceed` would never be set (the
        # coroutine could not run) and this wait would time out — the
        # wait_for() below then fails the test deterministically instead of
        # hanging.
        assert proceed.wait(timeout=2.0), "event loop was frozen — coroutine never ran"
        return {"outputs": {"done": True}}

    async def concurrent_marker() -> None:
        nonlocal loop_ran
        await asyncio.sleep(0.01)
        loop_ran = True
        proceed.set()

    result, _ = await asyncio.wait_for(
        asyncio.gather(_run_handler(blocking_handler, _REQ), concurrent_marker()),  # type: ignore[arg-type]
        timeout=3.0,
    )

    assert loop_ran is True
    assert result == {"outputs": {"done": True}}


@pytest.mark.asyncio
async def test_handler_exceptions_propagate_through_the_offload() -> None:
    def bad_handler(_req: object) -> dict:
        raise ValueError("ssrf blocked")

    # The exception must surface out of the await unchanged so the bridge's
    # existing ValueError -> INVALID_ARGUMENT mapping still fires.
    with pytest.raises(ValueError, match="ssrf blocked"):
        await _run_handler(bad_handler, _REQ)  # type: ignore[arg-type]
