# JARVIS workbench: the Linux desktop the LLM works in, pre-loaded as a capable
# research → development → local-testing sandbox (broad CLI toolchain, language
# runtimes, browser automation, and a data/ML stack) on top of the linuxserver
# webtop (Ubuntu + XFCE + noVNC) base.
#
# Internet: the image has internet during build (apt/pip below) and the container
# has outbound internet at runtime via the default Docker bridge network.
#
# NOTE: the base image already ships Node.js (NodeSource) — do NOT apt-install
# nodejs/npm here or it conflicts. Node + npm are already available.
FROM lscr.io/linuxserver/webtop:ubuntu-xfce

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
RUN playwright install --with-deps chromium firefox || playwright install chromium firefox || true

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

# Persistent project workspace (backed by a named volume in docker-compose) — work
# done here survives image rebuilds. This is the LLM's default working directory.
RUN mkdir -p /workspace

# Friendly aliases for tools Ubuntu ships under different names.
RUN ln -sf "$(command -v fdfind 2>/dev/null)" /usr/local/bin/fd 2>/dev/null || true; \
    ln -sf "$(command -v batcat 2>/dev/null)" /usr/local/bin/bat 2>/dev/null || true

LABEL org.jarvis.role="workbench" org.jarvis.description="LLM Linux workbench: CLI toolchain + Python/Node/Go/Java/Rust runtimes + web frameworks (Flask/FastAPI/Django, TS/Vite) + browser automation + data/ML sandbox"
