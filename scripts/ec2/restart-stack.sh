#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${1:-/home/ubuntu/docker-compose.yml}"
WORKERS_DIR="${WORKERS_DIR:-/home/ubuntu/mordecai-workers}"
REFRESH_WORKERS_API_DEP="${REFRESH_WORKERS_API_DEP:-1}"
CLEAN_WORKERS_NODE_MODULES="${CLEAN_WORKERS_NODE_MODULES:-1}"
ENFORCE_WORKERS_DOCKERIGNORE="${ENFORCE_WORKERS_DOCKERIGNORE:-1}"
ENFORCE_STACK_DOCKERIGNORE="${ENFORCE_STACK_DOCKERIGNORE:-1}"
SERVICES_TO_BUILD="${SERVICES_TO_BUILD:-mordecai-api mordecai-workers}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
elif docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
else
  echo "ERROR: neither docker-compose nor docker compose is available." >&2
  exit 1
fi

STACK_DIR="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"
echo "Using compose file: $COMPOSE_FILE"
echo "Working directory: $STACK_DIR"

ensure_stack_dockerignore() {
  if [[ "$ENFORCE_STACK_DOCKERIGNORE" != "1" ]]; then
    echo "Skipping stack .dockerignore enforcement (ENFORCE_STACK_DOCKERIGNORE=$ENFORCE_STACK_DOCKERIGNORE)"
    return
  fi

  local dockerignore_file
  dockerignore_file="$STACK_DIR/.dockerignore"

  cat > "$dockerignore_file" <<'EOF'
*
!mordecai-api/
!mordecai-api/**
!mordecai-workers/
!mordecai-workers/**
mordecai-api/.git
mordecai-api/node_modules
mordecai-api/.env
mordecai-workers/.git
mordecai-workers/node_modules
mordecai-workers/.env
EOF

  echo "Wrote $dockerignore_file for parent-context worker builds."
}

ensure_workers_dockerignore() {
  if [[ "$ENFORCE_WORKERS_DOCKERIGNORE" != "1" ]]; then
    echo "Skipping .dockerignore enforcement (ENFORCE_WORKERS_DOCKERIGNORE=$ENFORCE_WORKERS_DOCKERIGNORE)"
    return
  fi

  if [[ ! -d "$WORKERS_DIR" ]]; then
    echo "Skipping .dockerignore enforcement: workers dir not found at $WORKERS_DIR"
    return
  fi

  local dockerignore_file
  local changed
  dockerignore_file="$WORKERS_DIR/.dockerignore"
  changed=0
  touch "$dockerignore_file"

  for pattern in node_modules .git .env npm-debug.log; do
    if ! grep -qxF "$pattern" "$dockerignore_file"; then
      echo "$pattern" >> "$dockerignore_file"
      changed=1
    fi
  done

  if [[ "$changed" == "1" ]]; then
    echo "Updated $dockerignore_file to exclude mutable local artifacts from Docker build context."
  else
    echo "$dockerignore_file already has required exclusions."
  fi
}

cleanup_workers_node_modules() {
  if [[ "$CLEAN_WORKERS_NODE_MODULES" != "1" ]]; then
    echo "Skipping worker node_modules cleanup (CLEAN_WORKERS_NODE_MODULES=$CLEAN_WORKERS_NODE_MODULES)"
    return
  fi

  if [[ -d "$WORKERS_DIR/node_modules" ]]; then
    echo "Removing $WORKERS_DIR/node_modules to avoid stale dependency overlays in image builds."
    rm -rf "$WORKERS_DIR/node_modules"
  else
    echo "No local worker node_modules directory found at $WORKERS_DIR/node_modules"
  fi
}

refresh_workers_api_dependency() {
  if [[ "$REFRESH_WORKERS_API_DEP" != "1" ]]; then
    echo "Skipping worker dependency refresh (REFRESH_WORKERS_API_DEP=$REFRESH_WORKERS_API_DEP)"
    return
  fi

  if [[ ! -f "$WORKERS_DIR/package.json" ]]; then
    echo "Skipping worker dependency refresh: package.json not found in $WORKERS_DIR"
    return
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Skipping worker dependency refresh: node is not installed on the host."
    return
  fi

  local dep_spec
  dep_spec="$(
    node -e '
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write((pkg.dependencies && pkg.dependencies["mordecai-api"]) || "");
    ' "$WORKERS_DIR/package.json"
  )"

  if [[ -z "$dep_spec" ]]; then
    echo "Skipping worker dependency refresh: mordecai-api dependency not found in $WORKERS_DIR/package.json"
    return
  fi

  # If the worker depends on a Git ref, refresh lockfile to latest commit in that ref
  # so docker build does not keep an old pinned commit.
  if [[ "$dep_spec" == git+* || "$dep_spec" == github:* || "$dep_spec" == https://* ]]; then
    echo "Refreshing mordecai-api dependency lock in $WORKERS_DIR ($dep_spec)"
    (
      cd "$WORKERS_DIR"
      npm install --package-lock-only --force "mordecai-api@$dep_spec"
    )
  else
    echo "mordecai-api dependency is '$dep_spec' (non-git). Lock refresh step not required."
  fi
}

cd "$STACK_DIR"

ensure_stack_dockerignore
ensure_workers_dockerignore
refresh_workers_api_dependency
cleanup_workers_node_modules

"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" down --remove-orphans
docker system prune -f
"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" build --pull --no-cache $SERVICES_TO_BUILD
"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d --force-recreate
"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" ps
