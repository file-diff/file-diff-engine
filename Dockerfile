FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM ubuntu:26.04

WORKDIR /app

ARG DIFFT_TAG_NAME=0.68.0-dev.3
ARG OPENCODE_VERSION=1.14.28
ARG PUBLIC_GITHUB_TOKEN

ADD https://github.com/file-diff/difftastic/releases/download/${DIFFT_TAG_NAME}/difft-${DIFFT_TAG_NAME}-x86_64-unknown-linux-gnu.tar.xz /tmp/difft.tar.xz

# Install git and system CA certificates so TLS/SSL requests succeed
RUN apt-get update \
  && apt-get install -y git ca-certificates xz-utils \
  && tar -xJf /tmp/difft.tar.xz -C /tmp \
  && install -m 0755 /tmp/difft /usr/local/bin/difft

# Install Node.js (LTS) and npm
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs npm \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# Install node modules and build the application in the build stage
# Install essential system tools
RUN apt-get update && apt-get install -y \
    curl wget git build-essential sudo jq unzip zip nano vim \
    software-properties-common apt-transport-https ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Python 3 and pip
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*


# Install Go
RUN wget https://go.dev/dl/go1.22.1.linux-amd64.tar.gz \
    && tar -C /usr/local -xzf go1.22.1.linux-amd64.tar.gz \
    && rm go1.22.1.linux-amd64.tar.gz
ENV PATH=$PATH:/usr/local/go/bin

RUN npm i -g @openai/codex

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV PUBLIC_GITHUB_TOKEN=${PUBLIC_GITHUB_TOKEN}
ENV DIFFT_TAG_NAME=${DIFFT_TAG_NAME}
ENV OPENCODE_VERSION=${OPENCODE_VERSION}
ENV NODE_ENV=production
ENV REQUEST_DELAY_MS=0
ENV HOST=0.0.0.0
ENV PORT=12986
ENV TMP_DIR=/app/tmp
ENV HOME=/home/docker
ENV CODEX_MODEL=gpt-5.2-codex
ENV CODEX_BIN=codex
ENV CODEX_TIMEOUT_MS=7200000
ENV CODEX_OUTPUT_LIMIT=1000000
ENV OPENCODE_BIN=opencode
ENV OPENCODE_TIMEOUT_MS=7200000
ENV OPENCODE_OUTPUT_LIMIT=1000000

# Ensure tmp dir exists
RUN mkdir -p /app/tmp

# Create a 'docker' group and user with UID 649, make sure /app and /app/tmp are owned by it.
# Create a home directory at /home/docker for the user and give it a normal shell.
RUN groupadd -g 649 docker \
  && useradd -u 649 -g docker -m -d /home/docker -s /bin/bash docker \
  && mkdir -p /app/tmp /home/docker \
  && chown -R docker:docker /app /app/tmp /home/docker || true

EXPOSE 12986

# Run the container as the 'docker' user
USER docker

CMD ["npm", "start"]
