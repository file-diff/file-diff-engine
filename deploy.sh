#!/usr/bin/env bash

set -euo pipefail
set -x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
POSTGRES_DATA_DIR="${SCRIPT_DIR}/postgres_data"
REDIS_DATA_DIR="${SCRIPT_DIR}/redis_data"
REPOSITORIES_DATA_DIR="${SCRIPT_DIR}/repositories_data"
CODEX_DATA_DIR="${SCRIPT_DIR}/codex_data"

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

wait_for_postgres() {
  local attempts=30
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if docker compose exec -T postgres pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  echo "Postgres did not become ready in time." >&2
  return 1
}

escape_sql_literal() {
  printf "%s" "$1" | sed "s/'/''/g"
}

commit_hash="$(git rev-parse --short=7 HEAD)"
full_commit_hash="$(git rev-parse HEAD)"
build_version="${BUILD_VERSION:-${full_commit_hash}}"
short_hash_pattern="(^|[+.-])${commit_hash}($|[.-])"
full_hash_pattern="(^|[+.-])${full_commit_hash}($|[.-])"

if [[ ! "${build_version}" =~ ${short_hash_pattern} && ! "${build_version}" =~ ${full_hash_pattern} ]]; then
  if [[ "${build_version}" == *"+"* ]]; then
    build_version="${build_version}.${commit_hash}"
  else
    build_version="${build_version}+${commit_hash}"
  fi
fi

export BUILD_VERSION="${build_version}"

docker compose down

ensure_data_dir "${POSTGRES_DATA_DIR}" "70" "70"
ensure_data_dir "${REDIS_DATA_DIR}" "999" "999"
ensure_data_dir "${REPOSITORIES_DATA_DIR}" "649" "649"
ensure_data_dir "${CODEX_DATA_DIR}" "649" "649"

docker compose up -d --build app
