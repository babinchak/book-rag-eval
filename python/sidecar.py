"""
JSON-RPC sidecar for embedding and chat model calls.

Communication: line-delimited JSON over stdin/stdout. One JSON object per line.

Request shape:
    {"id": "<id>", "method": "embed", "params": {"texts": [...], "model": "..."}}

Success response:
    {"id": "<id>", "result": {...}}

Error response:
    {"id": "<id>", "error": {"message": "..."}}

Methods:
    ping                            -> "pong"
    embed(texts, model?)            -> {"embeddings": [[...], ...], "tokens": int}
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

DEFAULT_EMBEDDING_MODEL = "text-embedding-3-large"

# Harden stdio against malformed Unicode: never crash the sidecar on bad bytes.
# Lone surrogates (e.g. from JS strings or malformed EPUB content) survive JSON
# transport but break strict UTF-8 encoders downstream (httpx body encode).
try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


def _sanitize_text(text: str) -> str:
    """Strip code points that aren't valid in UTF-8 (lone surrogates, etc)."""
    return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def _send(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _send_response(req_id: Any, result: Any) -> None:
    _send({"id": req_id, "result": result})


def _send_error(req_id: Any, message: str) -> None:
    _send({"id": req_id, "error": {"message": message}})


def main() -> int:
    openai_api_key = os.environ.get("OPENAI_API_KEY")
    voyage_api_key = os.environ.get("VOYAGE_API_KEY")
    if not openai_api_key and not voyage_api_key:
        _send_error(None, "Neither OPENAI_API_KEY nor VOYAGE_API_KEY is set")
        return 1

    try:
        from openai import OpenAI
    except ImportError as e:
        _send_error(None, f"openai package not installed: {e}. Run: pip install openai")
        return 1

    openai_client = OpenAI(api_key=openai_api_key) if openai_api_key else None
    voyage_client = (
        OpenAI(api_key=voyage_api_key, base_url="https://api.voyageai.com/v1")
        if voyage_api_key
        else None
    )

    for raw in sys.stdin:
        line = raw.lstrip("\ufeff").strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _send_error(None, f"parse error: {e}")
            continue

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        try:
            if method == "ping":
                _send_response(req_id, "pong")
            elif method == "embed":
                texts = params.get("texts")
                if not isinstance(texts, list) or not texts:
                    raise ValueError("params.texts must be a non-empty list of strings")
                texts = [_sanitize_text(t) if isinstance(t, str) else t for t in texts]
                model = params.get("model") or DEFAULT_EMBEDDING_MODEL
                input_type = params.get("inputType")
                if model.startswith("voyage-"):
                    if voyage_client is None:
                        raise ValueError("VOYAGE_API_KEY is required for Voyage embeddings")
                    extra_body = {"input_type": input_type} if input_type else None
                    response = voyage_client.embeddings.create(
                        input=texts, model=model, extra_body=extra_body
                    )
                else:
                    if openai_client is None:
                        raise ValueError("OPENAI_API_KEY is required for OpenAI embeddings")
                    response = openai_client.embeddings.create(input=texts, model=model)
                result = {
                    "embeddings": [d.embedding for d in response.data],
                    "tokens": response.usage.total_tokens,
                    "model": model,
                }
                _send_response(req_id, result)
            elif method == "rerank":
                query = params.get("query")
                documents = params.get("documents")
                model = params.get("model") or "rerank-2.5-lite"
                if not isinstance(query, str) or not query:
                    raise ValueError("params.query must be a non-empty string")
                if not isinstance(documents, list) or not documents:
                    raise ValueError("params.documents must be a non-empty list of strings")
                if voyage_api_key is None:
                    raise ValueError("VOYAGE_API_KEY is required for Voyage reranking")
                body = json.dumps(
                    {
                        "query": _sanitize_text(query),
                        "documents": [
                            _sanitize_text(document) if isinstance(document, str) else document
                            for document in documents
                        ],
                        "model": model,
                        "top_k": len(documents),
                        "return_documents": False,
                        "truncation": False,
                    }
                ).encode("utf-8")
                request = urllib.request.Request(
                    "https://api.voyageai.com/v1/rerank",
                    data=body,
                    headers={
                        "Authorization": f"Bearer {voyage_api_key}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(request, timeout=120) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                except urllib.error.HTTPError as error:
                    detail = error.read().decode("utf-8", errors="replace")
                    raise ValueError(f"Voyage rerank HTTP {error.code}: {detail[:500]}") from error
                usage = payload.get("usage") or {}
                _send_response(
                    req_id,
                    {
                        "results": payload.get("data") or payload.get("results") or [],
                        "tokens": usage.get("total_tokens"),
                        "model": model,
                    },
                )
            elif method == "chat":
                messages = params.get("messages")
                if not isinstance(messages, list) or not messages:
                    raise ValueError("params.messages must be a non-empty list")
                for msg in messages:
                    if isinstance(msg.get("content"), str):
                        msg["content"] = _sanitize_text(msg["content"])
                model = params.get("model") or "gpt-4o-mini"
                temperature = params.get("temperature", 0.2)
                if openai_client is None:
                    raise ValueError("OPENAI_API_KEY is required for chat")
                response = openai_client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=temperature,
                )
                result = {
                    "content": response.choices[0].message.content or "",
                    "tokens": {
                        "prompt": response.usage.prompt_tokens,
                        "completion": response.usage.completion_tokens,
                        "total": response.usage.total_tokens,
                    },
                    "model": model,
                }
                _send_response(req_id, result)
            else:
                raise ValueError(f"unknown method: {method!r}")
        except Exception as e:
            _send_error(req_id, str(e))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
