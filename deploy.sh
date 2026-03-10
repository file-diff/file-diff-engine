#!/usr/bin/env bash

set -euo pipefail
set -x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGRES_DATA_DIR="${SCRIPT_DIR}/../postgres_data"
REDIS_DATA_DIR="${SCRIPT_DIR}/../redis_data"

ensure_data_dir() {
  local dir="$1"
  local image="$2"
  local uid="$3"
  local gid="$4"

  if [[ -d "${dir}" ]]; then
    return
  fi

  mkdir -p "${dir}"
  docker run --rm -v "${dir}:/data" --user root "${image}" sh -c "chown -R ${uid}:${gid} /data"
}

export BUILD_VERSION="${BUILD_VERSION:-$(git rev-parse HEAD)}"

ensure_data_dir "${POSTGRES_DATA_DIR}" "postgres:16-alpine" "70" "70"
ensure_data_dir "${REDIS_DATA_DIR}" "redis:7-alpine" "999" "999"

docker compose down
docker compose up -d --build
