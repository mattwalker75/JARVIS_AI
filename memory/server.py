"""
JARVIS semantic memory sidecar.

A thin FastAPI wrapper around the Mem0 OSS library. Mem0 gives the LLM real
long-term memory: it extracts salient facts from text, embeds them into a local
Chroma vector store, dedupes/updates them, and returns semantically relevant
memories on search (no exact-match SQL required).

It reads the OpenAI key + model from the same JARVIS_CONFIG.json the Node app
uses (mounted read-only), so there is nothing extra to configure. Everything is
self-hosted except the OpenAI calls for extraction + embeddings (swap the
embedder/llm to Ollama in build_memory() for a fully offline setup).
"""
import json
import os

from fastapi import FastAPI
from pydantic import BaseModel
from mem0 import Memory

CONFIG_FILE = os.environ.get("JARVIS_CONFIG_FILE", "/cfg/JARVIS_CONFIG.json")
CHROMA_PATH = os.environ.get("MEM0_CHROMA_PATH", "/data/chroma")
DEFAULT_USER = os.environ.get("MEM0_USER_ID", "default")


def load_llm_cfg():
    try:
        with open(CONFIG_FILE) as f:
            return (json.load(f) or {}).get("llm", {}) or {}
    except Exception:
        return {}


def build_memory():
    llm = load_llm_cfg()
    api_key = llm.get("api_key") or os.environ.get("OPENAI_API_KEY", "")
    model = llm.get("model", "gpt-4o-mini")
    # Mem0 reads OPENAI_API_KEY from the environment for both llm + embedder.
    if api_key:
        os.environ["OPENAI_API_KEY"] = api_key
    cfg = {
        "vector_store": {
            "provider": "chroma",
            "config": {"collection_name": "jarvis", "path": CHROMA_PATH},
        },
        "llm": {"provider": "openai", "config": {"model": model, "temperature": 0.1}},
        "embedder": {"provider": "openai", "config": {"model": "text-embedding-3-small"}},
    }
    return Memory.from_config(cfg)


app = FastAPI(title="JARVIS Memory")
mem = None


def memory():
    global mem
    if mem is None:
        mem = build_memory()
    return mem


class AddBody(BaseModel):
    text: str
    user_id: str | None = None
    metadata: dict | None = None


class SearchBody(BaseModel):
    query: str
    user_id: str | None = None
    limit: int | None = 8


class DeleteBody(BaseModel):
    memory_id: str


@app.get("/healthz")
def healthz():
    try:
        memory()  # force init so health reflects a usable store
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/add")
def add(body: AddBody):
    res = memory().add(
        body.text,
        user_id=body.user_id or DEFAULT_USER,
        metadata=body.metadata or {},
    )
    return {"results": res}


@app.post("/search")
def search(body: SearchBody):
    res = memory().search(
        body.query,
        filters={"user_id": body.user_id or DEFAULT_USER},
        limit=body.limit or 8,
    )
    items = res.get("results", res) if isinstance(res, dict) else res
    return {"results": items}


@app.get("/all")
def all_memories(user_id: str = DEFAULT_USER):
    res = memory().get_all(filters={"user_id": user_id})
    items = res.get("results", res) if isinstance(res, dict) else res
    return {"results": items}


@app.post("/delete")
def delete(body: DeleteBody):
    memory().delete(memory_id=body.memory_id)
    return {"deleted": body.memory_id}
