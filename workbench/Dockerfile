# JARVIS workbench: the Linux desktop the LLM works in, pre-loaded as a capable
# research → development → local-testing sandbox (broad CLI toolchain, language
# runtimes, browser automation, and a data/ML stack) on top of the linuxserver
# webtop (Ubuntu + XFCE + noVNC) base.
#
# Internet: the image has internet during build (apt/pip below) and the container
# has outbound internet at runtime via its own "workbench" compose network — which it
# shares only with jarvis-app (it can't reach the Docker API proxy or the memory store).
#
# NOTE: Node.js comes from Ubuntu's `nodejs` package below (no separate npm package —
# it would conflict if the base image's Node is newer). Check with `node -v` in the
# workbench after a rebuild.
#
# BASE_IMAGE is configurable (workbench.base_image in JARVIS_CONFIG.json → exported by
# ./JARVIS.sh --setup). The default floats on the latest ubuntu-xfce; for reproducible
# rebuilds PIN it to a digest of the image you know works, e.g.
#   "base_image": "lscr.io/linuxserver/webtop@sha256:<digest>"
# (get the digest of your current image with:
#   docker inspect --format '{{index .RepoDigests 0}}' lscr.io/linuxserver/webtop:ubuntu-xfce )
ARG BASE_IMAGE=lscr.io/linuxserver/webtop:ubuntu-xfce
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# Enable the universe + multiverse repos, then install a vast toolchain:
# shells, editors, VCS, build toolchains, languages, networking/research,
# database clients, file/text/data utilities, sysadmin/debug, and media/docs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends software-properties-common \
 && add-apt-repository -y universe \
 && add-apt-repository -y multiverse \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      bash zsh tmux screen \
      vim neovim nano emacs-nox \
      git git-lfs subversion mercurial \
      build-essential gcc g++ clang make cmake pkg-config autoconf automake libtool \
      python3 python3-pip python3-venv python3-dev pipx \
      nodejs \
      golang-go default-jdk-headless maven gradle ruby-full php-cli perl lua5.4 \
      curl wget ca-certificates gnupg lsb-release apt-transport-https \
      dnsutils net-tools iputils-ping traceroute mtr-tiny nmap netcat-openbsd socat tcpdump \
      openssh-client sshpass rsync whois httpie iperf3 ipcalc arp-scan \
      jq sqlite3 default-mysql-client postgresql-client redis-tools \
      less tree ripgrep fd-find fzf bat htop ncdu silversearcher-ag \
      file bc gawk sed moreutils datamash gnuplot-nox \
      lsof strace ltrace sysstat iotop psmisc \
      tig pv parallel expect dos2unix colordiff hexedit jo entr direnv universal-ctags \
      unzip zip tar gzip bzip2 xz-utils zstd p7zip-full unrar \
      ffmpeg imagemagick poppler-utils pandoc graphviz \
      shellcheck aspell man-db libnotify-bin \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) from the official apt repo — for clone/PR/issue/release workflows.
RUN mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# uv — fast Python package/venv manager (per-project envs + tool installs).
# Install into /usr/local/bin, NOT $HOME/.local/bin: at build time HOME=/config,
# which is a runtime volume that would mask anything installed under it.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh

# Python stack: research/scraping/docs + data/ML + Playwright browser automation
# (handles PEP 668 either way).
RUN pip3 install --no-cache-dir --break-system-packages \
      requests beautifulsoup4 lxml rich pyyaml csvkit yq httpx \
      fpdf2 reportlab markdown python-docx python-pptx openpyxl pillow matplotlib \
      pandas numpy scipy polars pyarrow scikit-learn jupyterlab duckdb sqlalchemy \
      playwright pytest-playwright \
   || pip3 install --no-cache-dir \
      requests beautifulsoup4 lxml rich pyyaml csvkit yq httpx \
      fpdf2 reportlab markdown python-docx python-pptx openpyxl pillow matplotlib \
      pandas numpy scipy polars pyarrow scikit-learn jupyterlab duckdb sqlalchemy \
      playwright pytest-playwright \
   || true

# Playwright browsers + their OS dependencies (reliable headless web automation/testing).
# Install to a FIXED image path — NOT the default ~/.cache under /config, which is a
# runtime volume that would SHADOW the browsers (the old durability trap). This path is
# baked into the image and survives fresh volumes and rebuilds.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# FAIL THE BUILD if chromium doesn't actually install — silently shipping a browserless
# workbench (the old `|| true`) is exactly what broke the browser tools before.
RUN (playwright install --with-deps chromium firefox || playwright install chromium firefox) \
    && ls -d /opt/ms-playwright/chromium-* >/dev/null 2>&1 \
    && echo "OK: playwright chromium installed at /opt/ms-playwright"

# --- Application frameworks & extra language tooling (so common stacks work OFFLINE) ---

# Python web frameworks (Flask / FastAPI / Django + prod servers) for building & serving apps.
RUN pip3 install --no-cache-dir --break-system-packages \
      flask "uvicorn[standard]" fastapi gunicorn starlette jinja2 \
      django djangorestframework aiohttp celery redis streamlit pydantic sqlmodel \
   || pip3 install --no-cache-dir \
      flask "uvicorn[standard]" fastapi gunicorn starlette jinja2 \
      django djangorestframework aiohttp celery redis streamlit pydantic sqlmodel \
   || true

# Node.js / TypeScript global toolchain: compilers, package managers, linters, bundlers,
# dev servers. Install under /usr/local (HOME=/config is a runtime volume that would mask
# $HOME-scoped globals). Frameworks themselves (React/Next/Vue/Angular/Svelte) are scaffolded
# per-project with `npx create-*` / `npm create`, the modern norm — no global install needed.
RUN npm install -g --prefix /usr/local \
      typescript ts-node tsx nodemon \
      yarn pnpm \
      eslint prettier \
      vite http-server serve npm-check-updates \
   || true

# Rust toolchain (rustup + cargo). Redirect CARGO/RUSTUP home OFF the /config volume so the
# toolchain survives at runtime, and put cargo/rustc on PATH.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal \
 && chmod -R a+rwX "$RUSTUP_HOME" "$CARGO_HOME"

# Go developer tools into a PATH dir via GOBIN (default $HOME/go/bin is a runtime volume at
# build time): golangci-lint (fast prebuilt linter) + air (live reload for Go web apps).
RUN GOBIN=/usr/local/bin GOPATH=/tmp/gobuild go install github.com/air-verse/air@latest || true; \
    curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh \
      | sh -s -- -b /usr/local/bin || true; \
    rm -rf /tmp/gobuild

# Python dev tooling + batteries libraries: linters / formatters / type-checkers /
# test runners, database drivers, config/CLI/logging helpers, extra plotting, and
# NLP/CV libraries. (Heavy ML stacks like torch/transformers are intentionally left
# out — they are CPU-only in-container and JARVIS runs model inference via Ollama on
# the host; add them explicitly if you ever want in-workbench experimentation.)
RUN pip3 install --no-cache-dir --break-system-packages \
      pytest pytest-asyncio pytest-cov coverage tox \
      ruff black isort mypy flake8 pylint bandit pre-commit \
      python-dotenv pydantic-settings click typer tenacity loguru tqdm faker orjson arrow \
      psycopg2-binary pymysql pymongo \
      seaborn plotly \
      nltk spacy opencv-python-headless \
   || pip3 install --no-cache-dir \
      pytest pytest-asyncio pytest-cov coverage tox \
      ruff black isort mypy flake8 pylint bandit pre-commit \
      python-dotenv pydantic-settings click typer tenacity loguru tqdm faker orjson arrow \
      psycopg2-binary pymysql pymongo \
      seaborn plotly \
      nltk spacy opencv-python-headless \
   || true

# A few more global Node CLIs: a process manager + task runners for serving/running apps.
RUN npm install -g --prefix /usr/local \
      pm2 concurrently npm-run-all \
   || true

# --- Extra utilities: OCR, media/document tooling, and the DuckDB CLI ---------------
# tesseract = exact OCR (complements the vision model, which paraphrases); exiftool =
# media metadata; qpdf = PDF surgery (split/merge/decrypt); yt-dlp = media downloads.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr libimage-exiftool-perl qpdf \
 && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp \
 || pip3 install --no-cache-dir yt-dlp

# DuckDB CLI (the Python lib is installed above; the CLI is what run_shell one-liners
# want, e.g. `duckdb /LLM_WORKSPACE/data.db "select ..."`). Arch-aware.
RUN set -e; case "$(uname -m)" in aarch64|arm64) A=arm64;; *) A=amd64;; esac; \
    curl -fsSL -o /tmp/duckdb.zip "https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-${A}.zip"; \
    unzip -o /tmp/duckdb.zip -d /usr/local/bin; chmod +x /usr/local/bin/duckdb; rm /tmp/duckdb.zip

# Speech-to-text: faster-whisper (CPU int8). The model itself (~75MB for "base")
# downloads on first use into the workbench home volume, so it persists.
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper \
 || pip3 install --no-cache-dir faster-whisper

# Git identity so the model's commits inside the workbench work on first use; system-wide
# (/etc/gitconfig) so it survives the /config home volume and applies to every user.
# safe.directory '*': bind-mounted repos are often owned by another uid.
RUN git config --system user.name "JARVIS Workbench" \
 && git config --system user.email "jarvis@workbench.local" \
 && git config --system init.defaultBranch main \
 && git config --system --add safe.directory '*'

# The LLM's working/build area — bind-mounted from ./LLM_WORKSPACE on the host
# (see docker-compose.yml), so it's visible on your Mac and persists across rebuilds.
# Set it as the container's default working directory.
RUN mkdir -p /LLM_WORKSPACE
WORKDIR /LLM_WORKSPACE

# Friendly aliases for tools Ubuntu ships under different names.
RUN ln -sf "$(command -v fdfind 2>/dev/null)" /usr/local/bin/fd 2>/dev/null || true; \
    ln -sf "$(command -v batcat 2>/dev/null)" /usr/local/bin/bat 2>/dev/null || true

# --- FINAL VERIFICATION: fail the build loudly if anything critical is missing ------
# Several install layers above use "|| ..." fallback chains (PEP-668 handling), which
# could silently ship a degraded workbench (exactly what once broke Playwright). This
# layer is the backstop: it checks every critical binary and Python module and FAILS
# the build with the full list of what's missing.
RUN set -e; missing=""; \
    for c in python3 pip3 node npm go cargo rustc java gh uv git rg fd fzf jq sqlite3 \
             ffmpeg convert pdftotext pandoc dot shellcheck tesseract exiftool qpdf \
             duckdb yt-dlp tsc vite http-server pm2 yarn pnpm eslint prettier; do \
      command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; \
    done; \
    for m in flask fastapi django pandas numpy scipy sklearn duckdb matplotlib \
             playwright docx openpyxl reportlab fpdf bs4 requests faster_whisper; do \
      python3 -c "import $m" >/dev/null 2>&1 || missing="$missing py:$m"; \
    done; \
    ls -d /opt/ms-playwright/chromium-* >/dev/null 2>&1 || missing="$missing playwright-chromium"; \
    if [ -n "$missing" ]; then echo "BUILD FAILED — missing critical workbench tools:$missing"; exit 1; fi; \
    echo "OK: workbench toolchain verified"

LABEL org.jarvis.role="workbench" org.jarvis.description="LLM Linux workbench: CLI toolchain + Python/Node/Go/Java/Rust runtimes + web frameworks (Flask/FastAPI/Django, TS/Vite) + browser automation + data/ML sandbox"
