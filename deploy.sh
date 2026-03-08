#!/usr/bin/env bash

set -x

docker compose down
docker compose up -d --build
