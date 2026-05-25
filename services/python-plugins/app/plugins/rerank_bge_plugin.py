"""Local BGE cross-encoder reranker plugin.

Loads a HuggingFace cross-encoder once at first call (~600MB for the
BAAI/bge-reranker-v2-m3 default) and keeps it resident for subsequent
calls. The TS rerank_bge plugin can target this sidecar by setting
`config.provider: "local"` instead of the default `"hf-api"`.

Why a separate plugin id (`rerank_bge_local`) instead of overloading
`rerank_bge`: the in-process v2 plugin already exists and works
against the HF Inference API. Routing the TS plugin to the sidecar
is a config-time choice on its side; from the sidecar's point of
view it's a distinct callable.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

logger = logging.getLogger("ragdoll.python-plugins.rerank_bge")

PLUGIN_ID = "rerank_bge_local"

# Lazy-loaded so the import cost (`torch`, `sentence_transformers`)
# only happens on the first call. The crawler plugins don't need
# these libraries; deployments that never use rerank_bge_local pay
# nothing.
_MODELS: Dict[str, Any] = {}


def _load_model(model_id: str):
    if model_id in _MODELS:
        return _MODELS[model_id]
    # Imported inside the function so:
    #  (a) the worker process doesn't pay the ~2-3s torch initialisation
    #      tax at boot when the plugin isn't going to be called;
    #  (b) sidecar images built without the `reranker` poetry group
    #      still boot — calls just fail here with a clear error.
    try:
        from sentence_transformers import CrossEncoder  # type: ignore
    except ImportError as exc:
        raise ValueError(
            "rerank_bge_local: sentence-transformers not installed. "
            "Rebuild the python-plugins image with the `reranker` poetry "
            "group enabled (see services/python-plugins/pyproject.toml)."
        ) from exc

    logger.info("loading cross-encoder model: %s", model_id)
    model = CrossEncoder(model_id)
    _MODELS[model_id] = model
    return model


def handle(request) -> Dict[str, Any]:
    """Score every (query, document) pair and return a JSON-shaped result.

    Expected body:
        config:
          model:       HF model id (default BAAI/bge-reranker-v2-m3)
          topK:        keep top-N after rerank (default 5)
          textField:   doc field carrying the text (default "text")
        inputs:
          question:    str
          documents:   [{id, text?, ...}]

    The TS rerank_bge plugin calls this via the standard
    /execute envelope; result mirrors what the HF-API branch returns
    so the upstream code path stays uniform.
    """
    config: Dict[str, Any] = request.config or {}
    inputs: Dict[str, Any] = request.inputs or {}
    question = str(inputs.get("question") or inputs.get("text") or "")
    documents: List[Dict[str, Any]] = list(inputs.get("documents") or [])
    if not documents:
        return {"outputs": {"documents": []}}
    if not question:
        raise ValueError("rerank_bge_local: question input is required")
    top_k = max(1, int(config.get("topK", 5)))
    text_field = str(config.get("textField", "text"))
    model_id = str(config.get("model", "BAAI/bge-reranker-v2-m3"))
    model = _load_model(model_id)
    # CrossEncoder expects [(query, doc_text), ...] and returns a numpy
    # array of floats. Higher = more relevant.
    pairs = [(question, str(d.get(text_field) or "")[:4000]) for d in documents]
    scores = model.predict(pairs)
    reranked = sorted(
        (
            {**doc, "rerankScore": float(scores[i])}
            for i, doc in enumerate(documents)
        ),
        key=lambda d: d["rerankScore"],
        reverse=True,
    )[:top_k]
    return {
        "outputs": {"documents": reranked},
        "usage": {"provider": "huggingface-local", "model": model_id},
    }
