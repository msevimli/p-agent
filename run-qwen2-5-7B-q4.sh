#!/usr/bin/env bash
# run-qwen2-5-7B-q4.sh — Qwen2.5 Coder 7B Q4_K_M via llama.cpp
# Parameter set (user-specified):
#   fa 1 + jinja, ctx 16384, np 1, batch 2048 / ubatch 512,
#   t 4 / tb 8, f16 KV cache, cache-reuse 256, port 8081
#
# Run with:  systemd-run --user --unit=qwen-7b-q4-server --collect \
#              --property=MemoryMax=12G --property=MemoryAccounting=yes \
#              --working-directory=/home/hermesai bash -c \
#              'bash /home/hermesai/p-agent/run-qwen2-5-7B-q4.sh > /home/hermesai/.hermes/cache/scratch/qwen-7b-q4-server.log 2>&1'

export PATH="/home/hermesai/llama.cpp/build/bin:$PATH"

llama-server -m /home/hermesai/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf \
  --alias qwen2.5-coder-7b-instruct-q4_k_m.gguf \
  -fa 1 --jinja \
  -c 16384 -np 1 \
  -b 2048 -ub 512 \
  -t 4 -tb 8 \
  --cache-type-k f16 --cache-type-v f16 \
  --cache-reuse 256 \
  --port 8081