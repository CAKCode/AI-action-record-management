#!/bin/sh
set -eu

umask 077

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR"

PORT="${PORT:-8091}"
HOST="${HOST:-127.0.0.1}"

export PORT HOST

exec node server.js
