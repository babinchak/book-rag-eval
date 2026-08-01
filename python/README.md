# Python sidecar

Spawned by the Electron main process to handle work that's better done in Python — currently just OpenAI embedding calls.

## Setup

Requires Python 3.10+ on PATH.

From the project root, just run:

```
npm run setup:python
```

This creates `python/.venv/`, installs the requirements, and that's it. The
Electron main process auto-detects this venv on startup — no activation, no
`PYTHON_BIN` env var needed.

## Optional local retrieval setup

ColBERTv2 and BGE-M3 experiments use a separate GPU environment:

```
npm run setup:retrieval-python
```

This creates `python/.retrieval-venv/` with pinned PyTorch, PyLate, and
FlagEmbedding packages. Model weights and generated indexes remain outside git.

## Manual run (debugging)

```powershell
$env:OPENAI_API_KEY = "sk-..."
python sidecar.py
```

Then paste a line:

```json
{"id":"1","method":"ping"}
```

You should get back:

```json
{"id":"1","result":"pong"}
```

## Protocol

Line-delimited JSON over stdin/stdout. See module docstring in `sidecar.py`.

The Electron main process sets `OPENAI_API_KEY` in the spawned process's
environment from Electron `safeStorage` (encrypted at rest, decrypted just before
spawn). The key never touches disk in plaintext.
