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
import re

from fastapi import FastAPI
from pydantic import BaseModel
from mem0 import Memory

CONFIG_FILE = os.environ.get("JARVIS_CONFIG_FILE", "/cfg/JARVIS_CONFIG.json")
CHROMA_PATH = os.environ.get("MEM0_CHROMA_PATH", "/data/chroma")
DEFAULT_USER = os.environ.get("MEM0_USER_ID", "default")


def load_cfg():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f) or {}
    except Exception:
        return {}


def build_memory():
    cfg_all = load_cfg()
    llm = cfg_all.get("llm", {}) or {}
    mem = cfg_all.get("mem0", {}) or {}
    api_key = llm.get("api_key") or os.environ.get("OPENAI_API_KEY", "")
    if api_key:
        os.environ["OPENAI_API_KEY"] = api_key

    # --- Extraction LLM: mirror the app's LLM so Mem0 uses WHATEVER model is in use
    # (local via Ollama, the gateway, or OpenAI). Ollama exposes an OpenAI-compatible
    # /v1, so the "openai" provider + a base_url works for all three. Override with
    # mem0.llm_model / mem0.llm_base_url. ---
    app_base = llm.get("base_url") or "https://api.openai.com/v1"
    llm_model = mem.get("llm_model") or llm.get("model") or "gpt-4o-mini"
    llm_base = mem.get("llm_base_url") or app_base
    llm_cfg = {"provider": "openai", "config": {
        "model": llm_model, "openai_base_url": llm_base,
        "api_key": api_key or "local", "temperature": 0.1,
    }}

    # --- Embedder: a chat model can't produce embeddings, so this is a SEPARATE model.
    # Uses the OpenAI-compatible API, which works for OpenAI OR a local Ollama endpoint
    # (Ollama serves /v1/embeddings). Default = OpenAI text-embedding-3-small (needs the
    # key). For a FULLY-LOCAL stack, set mem0.embed_base_url to your Ollama /v1 and
    # mem0.embed_model to a pulled embed model (e.g. nomic-embed-text). ---
    embed_cfg = {"provider": "openai", "config": {
        "model": mem.get("embed_model") or "text-embedding-3-small",
        "openai_base_url": mem.get("embed_base_url") or "https://api.openai.com/v1",
        "api_key": api_key or "local",
    }}

    # Namespace the collection BY EMBED MODEL: different embedders produce different
    # vector dimensions, and mixing them in one Chroma collection silently corrupts
    # search. Switching embed models now lands in a fresh collection (the old one stays
    # on disk for rollback) instead of breaking memory in a confusing way.
    embed_model = embed_cfg["config"]["model"]
    collection = "jarvis_" + re.sub(r"\W+", "_", embed_model).strip("_")

    # One-time migration: rename the legacy un-namespaced "jarvis" collection so
    # existing memories survive the change (only if the new name doesn't exist yet).
    try:
        import chromadb
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        names = [c.name for c in client.list_collections()]
        if "jarvis" in names and collection not in names:
            client.get_collection("jarvis").modify(name=collection)
            print(f"memory: migrated legacy collection 'jarvis' -> '{collection}'")
    except Exception as e:
        print(f"memory: legacy-collection migration skipped: {e}")
    print(f"memory: embedder={embed_model} collection={collection}")

    cfg = {
        "vector_store": {
            "provider": "chroma",
            "config": {"collection_name": collection, "path": CHROMA_PATH},
        },
        "llm": llm_cfg,
        "embedder": embed_cfg,
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


class UpdateBody(BaseModel):
    memory_id: str
    text: str


@app.get("/healthz")
def healthz():
    try:
        memory()  # force init so health reflects a usable store
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/add")
def add(body: AddBody):
    # infer=False (default) stores the fact DIRECTLY (just embed it) — reliable and fast,
    # and it works with any local model since it skips Mem0's LLM extraction/decision
    # stages (which break on reasoning models). The JARVIS chat model already decides
    # WHAT to remember before calling add_memory. Set mem0.infer=true to re-enable Mem0's
    # own LLM inference (dedup/merge) if your extraction model handles it well.
    infer = bool((load_cfg().get("mem0", {}) or {}).get("infer", False))
    res = memory().add(
        body.text,
        user_id=body.user_id or DEFAULT_USER,
        metadata=body.metadata or {},
        infer=infer,
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


@app.post("/update")
def update(body: UpdateBody):
    # Correct a memory in place (keeps its id) instead of delete + re-add.
    memory().update(memory_id=body.memory_id, data=body.text)
    return {"updated": body.memory_id}
