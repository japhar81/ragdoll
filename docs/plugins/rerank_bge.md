# BGE Cross-Encoder Reranker

Calls a HuggingFace cross-encoder (BGE-Reranker-v2-m3 by default) via
the HF Inference API to score each (question, document) pair. Batched
into one HTTP request; needs an `hfApiKey` secret.

## Inputs

- `question` (string, required).
- `documents` (`Array<{ id, text?, ...}>`, required).

## Outputs

- `documents` — top-`config.topK` candidates reordered by
  `rerankScore` (float, higher = more relevant).

## Gotchas

- This plugin uses HF Inference (hosted). For local cross-encoder
  inference you'd need a Python sidecar with the model weights — not
  in the box yet. Set `config.endpoint` to a private HF endpoint if
  you self-host the inference layer.
- `config.model` accepts any HuggingFace cross-encoder id. The default
  is `BAAI/bge-reranker-v2-m3` (multilingual, ~600MB).
- Document text truncated to 4000 chars per doc — HF endpoints have
  request size limits.
- `config.timeoutMs` (default 30s). HF cold-starts a model on first
  request; the second pass is fast.
- `hfApiKey`: a read-scope token is enough. Get one at
  https://huggingface.co/settings/tokens.

## Typical position

`dataset_search → rerank_bge → basic_rag_prompt → provider_chat`
