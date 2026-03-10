#!/usr/bin/env bash

set -x

export BUILD_VERSION="${BUILD_VERSION:-$(git rev-parse HEAD)}"

docker compose down
docker compose up -d --build
