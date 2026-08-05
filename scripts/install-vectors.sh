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
# Who the SERVICE runs as (the platform's own user) — separate from
# whoever is running this install script, which needs root for apt/systemd.
SERVICE_USER="${SQUIDCLAW_SERVICE_USER:-squidclaw}"

echo "🧭 growing vector memory in $DIR (model: $REPO)…"
if command -v apt-get >/dev/null; then
  # libssl-dev is not optional: the -hf Hugging Face resolver needs
  # HTTPS. Without it, cmake configures "successfully" (a silent warning,
  # not an error) and llama-server crash-loops forever at runtime instead.
  apt-get install -y -q cmake g++ git curl libssl-dev >/dev/null
fi

if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$DIR"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$DIR"
fi

cd "$DIR"
CONFIG_LOG=$(cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CURL=ON -DLLAMA_OPENSSL=ON 2>&1)
if echo "$CONFIG_LOG" | grep -qi 'openssl.*not found\|https support disabled'; then
  echo "⚠️ OpenSSL not found even after installing libssl-dev — the -hf downloader will not work."
  echo "$CONFIG_LOG" | grep -i openssl
  exit 1
fi
cmake --build build -j "$(nproc)" --target llama-server
BIN="$DIR/build/bin/llama-server"

# The model cache and the whole tree must be writable/readable by whoever
# the service runs as — llama-server downloads the model as that user.
mkdir -p "$DIR/.cache"
chown -R "$SERVICE_USER" "$DIR" 2>/dev/null || chmod -R a+rwX "$DIR"

echo ""
echo "Setting up the service (runs as $SERVICE_USER; also downloads the model on first start — be patient)…"
SERVICE=/etc/systemd/system/squidclaw-embeddings.service
cat > "$SERVICE" <<EOF
[Unit]
Description=SquidClaw vector memory — llama.cpp embedding server, model held hot
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Environment=HOME=$DIR/.cache
ExecStart=$BIN -hf $REPO --embedding --host 127.0.0.1 --port $PORT -t $(nproc)
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now squidclaw-embeddings

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
