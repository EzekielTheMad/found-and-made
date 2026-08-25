#!/bin/sh
set -eu

fail() {
  printf '%s\n' "Found & Made container setup error: $*" >&2
  exit 1
}

validate_id() {
  value=$1
  label=$2
  case "$value" in
    ''|*[!0-9]*) fail "$label must be a positive numeric Unix ID" ;;
  esac
  [ "$value" -gt 0 ] || fail "$label must not be root (0)"
}

validate_id "${PUID:-}" PUID
validate_id "${PGID:-}" PGID

case "${DATA_DIR:-}" in
  /) fail 'DATA_DIR must not be /' ;;
  /*) ;;
  *) fail 'DATA_DIR must be an absolute, non-root path' ;;
esac

# These are the complete durable-state contract. Do not create application data
# outside these documented paths, and do not recursively chown a mounted volume.
mkdir -p "$DATA_DIR"
chown "$PUID:$PGID" "$DATA_DIR"

for directory in db media media/originals media/web imports exports print keys backups; do
  mkdir -p "$DATA_DIR/$directory"
  chown "$PUID:$PGID" "$DATA_DIR/$directory"
done

exec gosu "$PUID:$PGID" "$@"
