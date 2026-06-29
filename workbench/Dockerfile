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
      golang-go default-jdk-headless ruby-full php-cli perl lua5.4 \
      curl wget ca-certificates gnupg lsb-release apt-transport-https \
      dnsutils net-tools iputils-ping traceroute mtr-tiny nmap netcat-openbsd socat tcpdump \
      openssh-client sshpass rsync whois httpie iperf3 ipcalc arp-scan \
      jq sqlite3 default-mysql-client postgresql-client redis-tools \
      less tree ripgrep fd-find fzf bat htop ncdu silversearcher-ag \
      file bc gawk sed moreutils datamash gnuplot-nox \
      lsof strace ltrace sysstat iotop psmisc \
      tig pv parallel expect dos2unix colordiff hexedit jo entr \
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

# Persistent project workspace (backed by a named volume in docker-compose) — work
# done here survives image rebuilds. This is the LLM's default working directory.
RUN mkdir -p /workspace

# Friendly aliases for tools Ubuntu ships under different names.
RUN ln -sf "$(command -v fdfind 2>/dev/null)" /usr/local/bin/fd 2>/dev/null || true; \
    ln -sf "$(command -v batcat 2>/dev/null)" /usr/local/bin/bat 2>/dev/null || true

LABEL org.jarvis.role="workbench" org.jarvis.description="LLM Linux workbench: CLI toolchain + browser automation + data/ML sandbox"
