"""CLI entry points (poetry scripts)."""

from __future__ import annotations

import os


def serve() -> None:
    """`poetry run serve` -> start uvicorn serving app.main:app.

    PORT env var (default 8000). HOST env var (default 0.0.0.0).
    """
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app.main:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    serve()
