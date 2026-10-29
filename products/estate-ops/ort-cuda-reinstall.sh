#!/usr/bin/env bash
# Reinstall CUDA-enabled ORT 1.21.0 libs into fastembed's nested onnxruntime-node.
# Idempotent. Run after any `bun install`/`npm install` that refreshes node_modules.
# Source stash: /home/toxic/build/ort-cuda-libs-1.21.0/
set -euo pipefail

STASH=/home/toxic/build/ort-cuda-libs-1.21.0
TARGET_BIN="${1:-/home/toxic/estate/projects/tau/engine/node_modules/fastembed/node_modules/onnxruntime-node/bin/napi-v3/linux/x64}"

for f in libonnxruntime.so.1.21.0 libonnxruntime_providers_cuda.so \
         libcudart.so.12 libcublas.so.12 libcublasLt.so.12 libcufft.so.11 libnvrtc.so.12; do
  [ -f "$STASH/$f" ] || { echo "MISSING: $STASH/$f"; exit 1; }
done
[ -d "$TARGET_BIN" ] || { echo "TARGET NOT FOUND: $TARGET_BIN"; exit 1; }

# Break bun's cross-node_modules hardlinks: remove first, then copy fresh inodes.
rm -f "$TARGET_BIN/libonnxruntime.so.1" "$TARGET_BIN/libonnxruntime.so.1.21.0"
cp "$STASH/libonnxruntime.so.1.21.0" "$TARGET_BIN/libonnxruntime.so.1.21.0"
cp "$STASH/libonnxruntime.so.1.21.0" "$TARGET_BIN/libonnxruntime.so.1"
for f in libonnxruntime_providers_cuda.so libcudart.so.12 libcublas.so.12 \
         libcublasLt.so.12 libcufft.so.11 libnvrtc.so.12; do
  cp -f "$STASH/$f" "$TARGET_BIN/$f"
done

# The dlopened provider .so needs its own $ORIGIN RUNPATH to find the CUDA libs.
patchelf --set-rpath '$ORIGIN' "$TARGET_BIN/libonnxruntime_providers_cuda.so"

# Smoke test: CUDA EP must load and compute correctly (no silent CPU fallback).
node -e "
const ort = require('$TARGET_BIN/../../../..');
(async () => {
  const s = await ort.InferenceSession.create('/tmp/tiny-matmul.onnx', {executionProviders: ['cuda']});
  const x = new ort.Tensor('float32', Float32Array.from([1,2,3,4,5,6]), [2,3]);
  const out = await s.run({X: x});
  const y = JSON.stringify(Array.from(out.Y.data));
  if (y !== '[1,2,4,5]') { console.error('WRONG RESULT: ' + y); process.exit(2); }
  console.log('ORT CUDA reinstall OK: session created, Y=' + y);
})().catch(e => { console.error('CUDA EP FAILED: ' + e.message.split('\n')[0]); process.exit(1); });
"
