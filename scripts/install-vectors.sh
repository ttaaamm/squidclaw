#!/usr/bin/env bash
# Grows SquidClaw's built-in VECTOR memory on this machine.
#
# llama.cpp (MIT, same family as whisper.cpp) run in --embedding mode: an
# open embedding model turns text into a point in space, so two memories
# with the same MEANING find each other even with zero shared words. No
# API, no cloud — the model runs on this box. Companion of
# scripts/install-ears.sh and scripts/install-voice.sh.
#
#   bash scripts/install-vectors.sh
#
# Model: nomic-embed-text-v1.5 (GGUF, ~280MB at Q8_0) — a well-established
# compact embedding model, fetched straight from Hugging Face via
# llama.cpp's own -hf resolver (no hand-built download URL to go stale).
# Swap SQUIDCLAW_EMBED_REPO if you later want a model with stronger
# Arabic coverage.
set -euo pipefail

DIR="${SQUIDCLAW_VECTORS_DIR:-/opt/llama-embed}"
REPO="${SQUIDCLAW_EMBED_REPO:-nomic-ai/nomic-embed-text-v1.5-GGUF}"
PORT="${SQUIDCLAW_EMBED_PORT:-8322}"

echo "🧭 growing vector memory in $DIR (model: $REPO)…"
if command -v apt-get >/dev/null; then
  sudo apt-get install -y -q cmake g++ git curl >/dev/null
fi

if [ ! -d "$DIR/.git" ]; then
  sudo mkdir -p "$DIR" && sudo chown "$(whoami)" "$DIR"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$DIR"
fi

cd "$DIR"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CURL=ON >/dev/null
cmake --build build -j "$(nproc)" --target llama-server
chmod -R a+rX "$DIR"
BIN="$DIR/build/bin/llama-server"

echo ""
echo "Setting up the service (this also downloads the model on first start — be patient)…"
SERVICE=/etc/systemd/system/squidclaw-embeddings.service
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=SquidClaw vector memory — llama.cpp embedding server, model held hot
After=network.target

[Service]
Type=simple
User=$(whoami)
Environment=HOME=$HOME
ExecStart=$BIN -hf $REPO --embedding --host 127.0.0.1 --port $PORT -t $(nproc)
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now squidclaw-embeddings

echo "Waiting for the model to load (first run downloads it — can take a minute)…"
for i in $(seq 1 60); do
  if curl -fsS -m 3 -X POST "http://127.0.0.1:$PORT/v1/embeddings" \
      -H 'content-type: application/json' -d '{"input":"hearing test"}' >/tmp/sq-embed-test.json 2>/dev/null; then
    break
  fi
  sleep 3
done

echo ""
if [ -s /tmp/sq-embed-test.json ]; then
  echo "✅ vector memory grown. Sample response:"
  head -c 200 /tmp/sq-embed-test.json; echo "…"
else
  echo "⚠️ not answering yet — check: journalctl -u squidclaw-embeddings -f"
fi

echo ""
echo "Add to your .env, then restart the service:"
echo "  SQUIDCLAW_EMBED_URL=http://127.0.0.1:$PORT"
