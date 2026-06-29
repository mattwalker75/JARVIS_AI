# JARVIS app: Node.js backend + static JS frontend.
ARG BASE_IMAGE=node:20-slim
FROM ${BASE_IMAGE}

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 80

CMD ["node", "server.js"]
