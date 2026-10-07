#!/usr/bin/env bash
# run-qwen2-5-7B-q5.sh — Qwen2.5 Coder 7B Q5_K_M via llama.cpp
# User-specified parameter set:
#   fa 1 + jinja, ctx 131072 (128K), np 1, batch 512 / ubatch 512,
#   t 6 / tb 2, f16 KV cache, cache-reuse 256, port 8083
#
# Managed by systemd user unit: qwen-7b-q5.service
#   systemctl --user start|stop|restart|status qwen-7b-q5

export PATH="/home/hermesai/llama.cpp/build/bin:$PATH"

llama-server -m /home/hermesai/models/qwen2.5-coder-7b-instruct-q5_k_m.gguf \
  --alias qwen2.5-coder-7b-instruct-q5_k_m.gguf \
  -fa 1 --jinja \
  -c 131072 -np 1 \
  -b 512 -ub 512 \
  -t 6 -tb 2 \
  --cache-type-k f16 --cache-type-v f16 \
  --cache-reuse 256 \
  --port 8083