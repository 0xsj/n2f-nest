#!/bin/sh
# End-to-end checks against the compiled backend in persistent mode:
#   1. the HTTP workflow suite,
#   2. the same suite after NATS restarts underneath the running process,
#   3. the same suite after PostgreSQL stops and starts underneath it,
#   4. a clean drain-and-close shutdown.
# Requires `bun run build` and the compose infrastructure (make infra-up).
set -eu

COMPOSE=${COMPOSE:-"docker compose -f compose.yaml"}
PORT=${N2F_E2E_PORT:-7390}
DATABASE_URL=${N2F_DATABASE_URL:?N2F_DATABASE_URL is required}
NATS_URL=${N2F_NATS_URL:?N2F_NATS_URL is required}
LOG=${N2F_E2E_LOG:-/tmp/n2f-e2e-backend.log}

wait_ready() {
  attempt=0
  until curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      echo "backend did not become ready; log follows" >&2
      cat "$LOG" >&2
      return 1
    fi
    sleep 1
  done
}

run_suite() {
  echo "== e2e: $1"
  N2F_DATABASE_URL="$DATABASE_URL" N2F_E2E_BASE_URL="http://127.0.0.1:$PORT" bun run test:e2e:persistent
}

N2F_STORAGE=postgres N2F_EVENT_TRANSPORT=nats \
  N2F_DATABASE_URL="$DATABASE_URL" N2F_NATS_URL="$NATS_URL" \
  N2F_NATS_STREAM=n2f_events N2F_NATS_SUBJECT_PREFIX=n2f.events. \
  N2F_DEV_ENDPOINTS=true N2F_SHUTDOWN_DRAIN_MS=1000 PORT="$PORT" \
  node dist/main.js >"$LOG" 2>&1 &
BACKEND=$!
trap 'kill "$BACKEND" 2>/dev/null || true' EXIT INT TERM

wait_ready
run_suite "workflow"

$COMPOSE restart nats
wait_ready
run_suite "after a NATS restart"

$COMPOSE stop postgres
sleep 3
$COMPOSE start postgres
wait_ready
run_suite "after a PostgreSQL restart"

echo "== e2e: graceful shutdown"
kill -TERM "$BACKEND"
sleep 0.3
status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health/ready" || true)
if [ "$status" != "503" ]; then
  echo "expected readiness 503 while draining, got $status" >&2
  exit 1
fi
wait "$BACKEND"
trap - EXIT INT TERM
echo "backend drained and exited cleanly"
