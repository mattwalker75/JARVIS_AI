# JARVIS app: Node.js backend + static JS frontend.
ARG BASE_IMAGE=node:20-slim
FROM ${BASE_IMAGE}

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 80

# Run as the unprivileged built-in 'node' user (uid 1000) instead of root, so an app-process
# compromise isn't automatically root-in-container. uid 1000 matches the workbench's PUID, so
# read/write to the bind-mounted shared folders (LLM_WORKSPACE, LLM_READ_WRITE_FILES, data, Logs,
# Prompts) and the config/secrets files keeps working. (On native Linux, ensure those host paths
# are writable by uid 1000; on Docker Desktop macOS/Windows this is automatic.)
USER node

CMD ["node", "server.js"]
