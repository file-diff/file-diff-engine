#!/usr/bin/env bash

  set -euo pipefail
  set -x

  POSTGRES_DATA_DIR="./postgres_data"
  REDIS_DATA_DIR="./redis_data"

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

  docker compose down
  docker compose up -d --build
