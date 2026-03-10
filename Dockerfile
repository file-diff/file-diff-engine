FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim

WORKDIR /app

# Install git and system CA certificates so TLS/SSL requests succeed
RUN apt-get update \
  && apt-get install -y git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

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
