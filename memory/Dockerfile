FROM python:3.12-slim

# Mem0 semantic-memory service for JARVIS. Chroma is the local vector store;
# OpenAI is used for fact extraction + embeddings (key read from JARVIS_CONFIG.json).
ENV PYTHONUNBUFFERED=1 \
    ANONYMIZED_TELEMETRY=False \
    MEM0_CHROMA_PATH=/data/chroma

WORKDIR /app

RUN pip install --no-cache-dir \
      "mem0ai>=0.1.40" \
      "chromadb>=0.5" \
      "fastapi>=0.110" \
      "uvicorn[standard]>=0.29"

COPY server.py /app/server.py

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
