#!/usr/bin/env bash

set -euo pipefail
set -x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
POSTGRES_DATA_DIR="${SCRIPT_DIR}/postgres_data"
REDIS_DATA_DIR="${SCRIPT_DIR}/redis_data"
REPOSITORIES_DATA_DIR="${SCRIPT_DIR}/repositories_data"

ensure_data_dir() {
  local dir="$1"
  local uid="$2"
  local gid="$3"

  if [[ -d "${dir}" ]]; then
    return
  fi

  mkdir -p "${dir}"

  if chown -R "${uid}:${gid}" "${dir}" 2>/dev/null; then
    :
  else
    sudo chown -R "${uid}:${gid}" "${dir}"
  fi
}

export BUILD_VERSION="${BUILD_VERSION:-$(git rev-parse HEAD)}"

ensure_data_dir "${POSTGRES_DATA_DIR}" "70" "70"
ensure_data_dir "${REDIS_DATA_DIR}" "999" "999"
ensure_data_dir "${REPOSITORIES_DATA_DIR}" "649" "649"

docker compose down
docker compose up -d --build
