"""Line-delimited JSON-RPC service for local ColBERTv2 and BGE-M3 retrieval."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

RPC_STDOUT = sys.stdout
sys.stdout = sys.stderr

try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    RPC_STDOUT.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

_colbert_models: dict[str, Any] = {}
_bge_models: dict[str, Any] = {}


def _send(payload: dict[str, Any]) -> None:
    RPC_STDOUT.write(json.dumps(payload, separators=(",", ":")) + "\n")
    RPC_STDOUT.flush()


def _response(request_id: Any, result: Any) -> None:
    _send({"id": request_id, "result": result})


def _error(request_id: Any, error: Exception) -> None:
    _send({"id": request_id, "error": {"message": str(error)}})


def _documents(params: dict[str, Any]) -> tuple[list[str], list[str]]:
    documents = params.get("documents")
    if not isinstance(documents, list) or not documents:
        raise ValueError("params.documents must be a non-empty list")
    ids: list[str] = []
    texts: list[str] = []
    for document in documents:
        if not isinstance(document, dict):
            raise ValueError("each document must be an object")
        document_id = document.get("id")
        text = document.get("text")
        if not isinstance(document_id, str) or not isinstance(text, str):
            raise ValueError("each document requires string id and text fields")
        ids.append(document_id)
        texts.append(text)
    return ids, texts


def _colbert_model(model_name: str) -> Any:
    model = _colbert_models.get(model_name)
    if model is None:
        from pylate import models

        model = models.ColBERT(model_name_or_path=model_name)
        _colbert_models[model_name] = model
    return model


def _colbert_index(params: dict[str, Any]) -> dict[str, Any]:
    from pylate import indexes

    artifact_dir = Path(params["artifactDir"]).resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    ids, texts = _documents(params)
    model_name = params.get("model") or "lightonai/colbertv2.0"
    batch_size = int(params.get("batchSize") or 16)
    started = time.perf_counter()
    model = _colbert_model(model_name)
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        is_query=False,
        show_progress_bar=True,
    )
    index = indexes.PLAID(
        index_folder=str(artifact_dir),
        index_name="index",
        override=True,
    )
    index.add_documents(documents_ids=ids, documents_embeddings=embeddings)
    manifest = {
        "schemaVersion": 1,
        "kind": "colbertv2-plaid",
        "model": model_name,
        "documents": len(ids),
        "createdAt": int(time.time() * 1000),
    }
    (artifact_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {**manifest, "indexingLatencyMs": (time.perf_counter() - started) * 1000}


def _colbert_query(params: dict[str, Any]) -> dict[str, Any]:
    from pylate import indexes, retrieve

    artifact_dir = Path(params["artifactDir"]).resolve()
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    query = params.get("query")
    if not isinstance(query, str) or not query:
        raise ValueError("params.query must be a non-empty string")
    k = int(params.get("k") or 50)
    started = time.perf_counter()
    model = _colbert_model(manifest["model"])
    index = indexes.PLAID(
        index_folder=str(artifact_dir),
        index_name="index",
        override=False,
    )
    query_embeddings = model.encode(
        [query],
        batch_size=1,
        is_query=True,
        show_progress_bar=False,
    )
    results = retrieve.ColBERT(index=index).retrieve(query_embeddings=query_embeddings, k=k)[0]
    return {
        "hits": [
            {"id": str(hit["id"]), "score": float(hit["score"]), "rank": rank}
            for rank, hit in enumerate(results, start=1)
        ],
        "queryLatencyMs": (time.perf_counter() - started) * 1000,
    }


def _bge_model(model_name: str) -> Any:
    model = _bge_models.get(model_name)
    if model is None:
        from FlagEmbedding import BGEM3FlagModel

        model = BGEM3FlagModel(model_name, use_fp16=True)
        _bge_models[model_name] = model
    return model


def _bge_index(params: dict[str, Any]) -> dict[str, Any]:
    import numpy as np

    artifact_dir = Path(params["artifactDir"]).resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    ids, texts = _documents(params)
    model_name = params.get("model") or "BAAI/bge-m3"
    batch_size = int(params.get("batchSize") or 8)
    max_length = int(params.get("maxLength") or 512)
    started = time.perf_counter()
    model = _bge_model(model_name)
    output = model.encode(
        texts,
        batch_size=batch_size,
        max_length=max_length,
        return_dense=True,
        return_sparse=True,
        return_colbert_vecs=True,
    )
    dense = np.asarray(output["dense_vecs"], dtype=np.float16)
    colbert_vectors = [np.asarray(vector, dtype=np.float16) for vector in output["colbert_vecs"]]
    offsets = np.zeros(len(colbert_vectors) + 1, dtype=np.int64)
    for index, vector in enumerate(colbert_vectors):
        offsets[index + 1] = offsets[index] + vector.shape[0]
    flattened = np.concatenate(colbert_vectors, axis=0)
    np.save(artifact_dir / "dense.npy", dense)
    np.save(artifact_dir / "colbert.npy", flattened)
    np.save(artifact_dir / "colbert-offsets.npy", offsets)
    (artifact_dir / "ids.json").write_text(json.dumps(ids), encoding="utf-8")
    (artifact_dir / "sparse.json").write_text(
        json.dumps(output["lexical_weights"], separators=(",", ":")), encoding="utf-8"
    )
    manifest = {
        "schemaVersion": 1,
        "kind": "bge-m3",
        "model": model_name,
        "documents": len(ids),
        "maxLength": max_length,
        "denseDimensions": int(dense.shape[1]),
        "colbertDimensions": int(flattened.shape[1]),
        "colbertVectors": int(flattened.shape[0]),
        "createdAt": int(time.time() * 1000),
    }
    (artifact_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {**manifest, "indexingLatencyMs": (time.perf_counter() - started) * 1000}


def _sparse_score(query_weights: dict[str, float], document_weights: dict[str, float]) -> float:
    if len(query_weights) > len(document_weights):
        query_weights, document_weights = document_weights, query_weights
    return sum(float(weight) * float(document_weights.get(token, 0.0)) for token, weight in query_weights.items())


def _bge_query(params: dict[str, Any]) -> dict[str, Any]:
    import numpy as np
    import torch

    artifact_dir = Path(params["artifactDir"]).resolve()
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    ids = json.loads((artifact_dir / "ids.json").read_text(encoding="utf-8"))
    query = params.get("query")
    if not isinstance(query, str) or not query:
        raise ValueError("params.query must be a non-empty string")
    mode = params.get("mode") or "dense"
    k = min(int(params.get("k") or 50), len(ids))
    shortlist = min(int(params.get("shortlist") or 200), len(ids))
    started = time.perf_counter()
    model = _bge_model(manifest["model"])
    output = model.encode(
        [query],
        batch_size=1,
        max_length=manifest["maxLength"],
        return_dense=True,
        return_sparse=True,
        return_colbert_vecs=True,
    )
    dense = np.load(artifact_dir / "dense.npy", mmap_mode="r")
    query_dense = np.asarray(output["dense_vecs"][0], dtype=np.float32)
    dense_scores = np.asarray(dense, dtype=np.float32) @ query_dense
    if mode == "dense":
        ranked_indices = np.argsort(-dense_scores)[:k]
        scores = dense_scores[ranked_indices]
    elif mode == "sparse":
        sparse = json.loads((artifact_dir / "sparse.json").read_text(encoding="utf-8"))
        query_sparse = output["lexical_weights"][0]
        sparse_scores = np.asarray(
            [_sparse_score(query_sparse, document) for document in sparse], dtype=np.float32
        )
        ranked_indices = np.argsort(-sparse_scores)[:k]
        scores = sparse_scores[ranked_indices]
    elif mode == "colbert-dense-shortlist":
        candidate_indices = np.argsort(-dense_scores)[:shortlist]
        vectors = np.load(artifact_dir / "colbert.npy", mmap_mode="r")
        offsets = np.load(artifact_dir / "colbert-offsets.npy", mmap_mode="r")
        query_vectors = torch.as_tensor(
            np.asarray(output["colbert_vecs"][0], dtype=np.float32), device="cuda"
        )
        late_scores: list[float] = []
        with torch.inference_mode():
            for candidate_index in candidate_indices:
                document_vectors = torch.as_tensor(
                    np.asarray(
                        vectors[offsets[candidate_index] : offsets[candidate_index + 1]],
                        dtype=np.float32,
                    ),
                    device="cuda",
                )
                score = (query_vectors @ document_vectors.T).max(dim=1).values.sum()
                late_scores.append(float(score.item()))
        order = np.argsort(-np.asarray(late_scores, dtype=np.float32))[:k]
        ranked_indices = candidate_indices[order]
        scores = np.asarray(late_scores, dtype=np.float32)[order]
    else:
        raise ValueError(f"unknown BGE-M3 query mode: {mode}")
    return {
        "hits": [
            {"id": ids[int(index)], "score": float(score), "rank": rank}
            for rank, (index, score) in enumerate(zip(ranked_indices, scores), start=1)
        ],
        "queryLatencyMs": (time.perf_counter() - started) * 1000,
    }


def main() -> int:
    for raw in sys.stdin:
        line = raw.lstrip("\ufeff").strip()
        if not line:
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params") or {}
            if method == "ping":
                import torch

                result = {
                    "status": "ok",
                    "torch": torch.__version__,
                    "cuda": torch.cuda.is_available(),
                    "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                }
            elif method == "colbert_index":
                result = _colbert_index(params)
            elif method == "colbert_query":
                result = _colbert_query(params)
            elif method == "bge_index":
                result = _bge_index(params)
            elif method == "bge_query":
                result = _bge_query(params)
            else:
                raise ValueError(f"unknown method: {method!r}")
            _response(request_id, result)
        except Exception as error:
            _error(request_id, error)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
