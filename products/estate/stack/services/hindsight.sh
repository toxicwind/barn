#!/usr/bin/env bash
# Hindsight — vectorize-io/hindsight agent memory (estate)
# Maps: 8888 -> HINDSIGHT_API_PORT (25117), 9999 -> HINDSIGHT_CP_PORT (25118)
# Docs: https://hindsight.vectorize.io/developer/installation
# Image: ghcr.io/vectorize-io/hindsight:latest  (~9GB, named volume for embedded pg)
set -euo pipefail
# 2026-10-27: SOV must default to the estate CLONE — stack/lib-ports.sh and
# the rest of the service scaffolding live here (the pens/estate namespace
# pen whitelists only bin/ + docs/, so its stack/ is not the SSOT and was
# missing lib-ports.sh entirely: hindsight died on source for the 80th time).
SOV="${ESTATE_ROOT:-/home/toxic/pens/estate}"
source "$SOV/stack/lib-ports.sh"
require_env HINDSIGHT_API_PORT
require_env HINDSIGHT_CP_PORT

API_PORT="$HINDSIGHT_API_PORT"
CP_PORT="$HINDSIGHT_CP_PORT"

# Resolve LLM credentials — prefer Hindsight-specific, fallback to OpenAI
# 25+ providers supported via HINDSIGHT_API_LLM_PROVIDER (openai, anthropic, groq, ollama, etc.)
LLM_KEY="${HINDSIGHT_API_LLM_API_KEY:-$(cat /home/toxic/.rhodochrosite-data/client-key.corral 2>/dev/null)}"
LLM_PROVIDER="${HINDSIGHT_API_LLM_PROVIDER:-openai}"
HINDSIGHT_API_LLM_BASE_URL="${HINDSIGHT_API_LLM_BASE_URL:-http://127.0.0.1:25193/v1}"
LLM_MODEL="${HINDSIGHT_API_LLM_MODEL:?must be set in pitchfork.toml [daemons.hindsight.env]}"
# Allow empty key for local providers (ollama, lmstudio) or Cloud-bypass;
# container still starts but retain/reflect requiring LLM will error until key is set.
if [[ -z "${LLM_KEY}" ]]; then
  echo "[hindsight] WARN: HINDSIGHT_API_LLM_API_KEY/OPENAI_API_KEY empty — LLM calls will fail until set." >&2
  echo "[hindsight]      Set in ~/.secrets or .env.local: export HINDSIGHT_API_LLM_API_KEY=sk-..." >&2
fi

# Clean stale listeners / containers (pitchfork will retry on failure)
fuser -k "${API_PORT}/tcp" 2>/dev/null || true
fuser -k "${CP_PORT}/tcp" 2>/dev/null || true
docker rm -f hindsight 2>/dev/null || true
sleep 0.3

# Ensure named volume exists (preferred over host bind; avoids UID 1000 chown issues)
docker volume create hindsight-data >/dev/null 2>&1 || true

# Build docker env passthrough
DOCKER_ENV=(
  -e "HINDSIGHT_API_PORT=${API_PORT}"
  -e "HINDSIGHT_CP_PORT=${CP_PORT}"
  -e "HINDSIGHT_API_LLM_PROVIDER=${LLM_PROVIDER}"
  -e "HINDSIGHT_API_LLM_BASE_URL=${HINDSIGHT_API_LLM_BASE_URL}"
  -e "HINDSIGHT_API_LLM_MODEL=${LLM_MODEL}"
  -e "HINDSIGHT_API_WORKER_ID=${HINDSIGHT_API_WORKER_ID:-hindsight-awrawr}"
  -e "HINDSIGHT_API_LLM_MAX_CONCURRENT=${HINDSIGHT_API_LLM_MAX_CONCURRENT:-1}"
  -e "HINDSIGHT_API_RETAIN_MAX_CONCURRENT=${HINDSIGHT_API_RETAIN_MAX_CONCURRENT:-1}"
  -e "HINDSIGHT_API_WORKER_MAX_SLOTS=${HINDSIGHT_API_WORKER_MAX_SLOTS:-2}"
  -e "HINDSIGHT_API_LLM_TIMEOUT=${HINDSIGHT_API_LLM_TIMEOUT:-300}"
  -e "HINDSIGHT_API_RETAIN_WALL_TIMEOUT=${HINDSIGHT_API_RETAIN_WALL_TIMEOUT:-600}"
)
# Pass through any HINDSIGHT_* overrides from host env (cp access key, etc.)
for v in HINDSIGHT_CP_ACCESS_KEY HINDSIGHT_CP_DATAPLANE_API_URL HINDSIGHT_API_PORT HINDSIGHT_CP_PORT HINDSIGHT_API_WORKER_ID HINDSIGHT_API_LLM_MAX_CONCURRENT HINDSIGHT_API_RETAIN_MAX_CONCURRENT HINDSIGHT_API_WORKER_MAX_SLOTS; do
  if [[ -n "${!v:-}" ]]; then
    DOCKER_ENV+=(-e "$v=${!v}")
  fi
done

echo "[hindsight] starting ghcr.io/vectorize-io/hindsight:latest on :${API_PORT}->8888 api, :${CP_PORT}->9999 cp (provider=${LLM_PROVIDER})"

# exec replaces shell — pitchfork tracks docker as the daemon pid; logs stream via pitchfork.
# --pull always ensures latest; --rm lets pitchfork restart cleanly; --shm-size=1g required by docs.
# --name hindsight stable for volume attachment.
ENVFILE=$(mktemp /dev/shm/hsight.XXXXXX)
chmod 600 "$ENVFILE"
printf "HINDSIGHT_API_LLM_API_KEY=%s\n" "$LLM_KEY" > "$ENVFILE"
trap "rm -f $ENVFILE" EXIT

exec docker run --rm \
  --env-file "$ENVFILE" \
  --pull missing \
  --name hindsight \
  --restart no \
  --shm-size=1g \
  --network host \
  -v hindsight-data:/home/hindsight/.pg0 \
  "${DOCKER_ENV[@]}" \
  ghcr.io/vectorize-io/hindsight:latest
