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
  && apt-get install -y git ca-certificates

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=12986
ENV TMP_DIR=/app/tmp

RUN mkdir -p /app/tmp

EXPOSE 12986

CMD ["npm", "start"]
