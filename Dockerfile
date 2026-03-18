FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim

WORKDIR /app

ARG DIFFT_TAG_NAME=0.68.0-dev.4

ADD https://github.com/file-diff/difftastic/releases/download/${DIFFT_TAG_NAME}/difft-${DIFFT_TAG_NAME}-x86_64-unknown-linux-gnu.tar.xz /tmp/difft.tar.xz

# Install git and system CA certificates so TLS/SSL requests succeed
RUN apt-get update \
  && apt-get install -y git ca-certificates xz-utils \
  && tar -xJf /tmp/difft.tar.xz -C /tmp \
  && install -m 0755 /tmp/difft /usr/local/bin/difft \
  && rm -f /tmp/difft /tmp/difft.tar.xz \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV DIFFT_TAG_NAME=${DIFFT_TAG_NAME}
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=12986
ENV TMP_DIR=/app/tmp

# Ensure tmp dir exists
RUN mkdir -p /app/tmp

# Create a 'docker' group and user with UID 649, make sure /app and /app/tmp are owned by it.
# Using -M to avoid creating a home directory and /bin/false as shell for safety.
RUN groupadd -g 649 docker \
  && useradd -u 649 -g docker -M -s /bin/false docker \
  && chown -R docker:docker /app || true

EXPOSE 12986

# Run the container as the 'docker' user
USER docker

CMD ["npm", "start"]
