#!/bin/sh
set -eu

umask 077

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR"

DEFAULT_RUNTIME_DIR="$(dirname "$PROJECT_DIR")/.${PROJECT_DIR##*/}-runtime"
SERVICE_ENV_FILE="${CODEX_SERVICE_ENV_FILE:-$DEFAULT_RUNTIME_DIR/service.env}"
if [ -e "$SERVICE_ENV_FILE" ]; then
  if [ ! -f "$SERVICE_ENV_FILE" ] || [ -L "$SERVICE_ENV_FILE" ]; then
    echo "Unsafe service environment file: $SERVICE_ENV_FILE" >&2
    exit 1
  fi
  SERVICE_ENV_MODE="$(stat -c '%a' "$SERVICE_ENV_FILE")"
  case "$SERVICE_ENV_MODE" in
    600|400) ;;
    *)
      echo "Service environment file must use mode 600 or 400: $SERVICE_ENV_FILE" >&2
      exit 1
      ;;
  esac
  set -a
  # shellcheck disable=SC1090
  . "$SERVICE_ENV_FILE"
  set +a
fi

PORT="${PORT:-8091}"
HOST="${HOST:-127.0.0.1}"

export PORT HOST

exec node bin/web-launcher.js
