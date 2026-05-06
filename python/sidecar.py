"""
JSON-RPC sidecar for OpenAI embedding calls.

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
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        _send_error(None, "OPENAI_API_KEY not set in sidecar environment")
        return 1

    try:
        from openai import OpenAI
    except ImportError as e:
        _send_error(None, f"openai package not installed: {e}. Run: pip install openai")
        return 1

    client = OpenAI(api_key=api_key)

    for raw in sys.stdin:
        line = raw.strip()
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
                response = client.embeddings.create(input=texts, model=model)
                result = {
                    "embeddings": [d.embedding for d in response.data],
                    "tokens": response.usage.total_tokens,
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
