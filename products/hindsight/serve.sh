#!/usr/bin/env bash
# Hindsight memory API for tau (apiUrl http://127.0.0.1:25117). Foreground docker so pitchfork tracks the PID.
# Data: named volume hindsight-data (embedded pg0) mounted at /home/hindsight/.pg0.
# LLM lane (retain extraction): mimetite gateway on :25193 (qwen3.6-35b).
# 2026-11-12: was pointing at the bornite local lane :25196 with qwen2.5-3b
# + MAX_CONCURRENT=12 — hindsight flooded the 2-slot local server with
# oversized-context requests (17k tokens > 16384 slot ctx) and wedged it.
# The gateway has its own concurrency limiter; 2 concurrent is plenty here.
set -euo pipefail
NAME=hindsight
docker rm -f "$NAME" >/dev/null 2>&1 || true
exec docker run --env-file /home/toxic/pens/barn/products/hindsight/embeddings.env --rm --name "$NAME" --network host \
  -v hindsight-data:/home/hindsight/.pg0 \
  -e HINDSIGHT_API_HOST=127.0.0.1 \
  -e HINDSIGHT_API_PORT=25117 \
  -e HINDSIGHT_ENABLE_API=true \
  -e HINDSIGHT_ENABLE_CP=false \
  -e HINDSIGHT_API_LLM_PROVIDER=openai \
  -e HINDSIGHT_API_LLM_MODEL=nim-deepseek-v4-flash \
  -e HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:25193/v1 \
  -e HINDSIGHT_API_LLM_API_KEY=local \
  -e HINDSIGHT_API_LLM_MAX_CONCURRENT=2 \
  -e HINDSIGHT_API_WORKER_MAX_SLOTS=2 \
  -e HINDSIGHT_API_WORKER_RETAIN_RESERVED_SLOTS=1 \
  -e HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS=1 \
  ghcr.io/vectorize-io/hindsight:latest
