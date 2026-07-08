# jarvis-piper: offline neural text-to-speech (Piper) behind a tiny HTTP API.
#
# Fully local and machine-independent: the Piper engine + voice models are baked into
# the image at build time, so at runtime nothing here needs the internet. The arch is
# auto-detected (TARGETARCH) so the same Dockerfile builds on Apple Silicon (arm64)
# and x86_64 hosts alike — the voice travels with JARVIS wherever it runs.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG PIPER_VERSION=2023.11.14-2

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

# Piper engine (self-contained: bundles its own libs + espeak-ng data).
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      arm64) PARCH=aarch64 ;; \
      amd64) PARCH=x86_64 ;; \
      *)     PARCH=x86_64 ;; \
    esac; \
    curl -fsSL -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PARCH}.tar.gz"; \
    tar xzf /tmp/piper.tar.gz -C /opt; \
    rm /tmp/piper.tar.gz

# Voice models (a curated en set). Kept in its own layer so it caches independently of
# the engine layer above.
ENV VOICES_DIR=/opt/voices
COPY download-voices.sh /tmp/download-voices.sh
RUN bash /tmp/download-voices.sh && rm /tmp/download-voices.sh

COPY serve.py /opt/serve.py

ENV PIPER_BIN=/opt/piper/piper \
    ESPEAK_DATA=/opt/piper/espeak-ng-data \
    DEFAULT_VOICE=en_US-amy-medium \
    PORT=5000

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:5000/healthz || exit 1
CMD ["python3", "/opt/serve.py"]
