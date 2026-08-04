#!/usr/bin/env bash
# Grows SquidClaw's built-in ears on this machine.
#
# whisper.cpp (MIT) compiled locally + an open Whisper model (MIT): free
# transcription in every language Whisper knows, Arabic included — no API,
# no keys, audio never leaves the box. Like ffmpeg or Gotenberg, the binary
# is a system organ; this script is how the repo owns its growth.
#
#   bash scripts/install-ears.sh [tiny|base|small|medium]   (default: small)
#
# small is the sweet spot for Arabic on a 4-core box (~466MB, ~1GB RAM).
set -euo pipefail

DIR="${SQUIDCLAW_WHISPER_DIR:-/opt/whisper}"
MODEL="${1:-small}"

echo "🦻 growing ears in $DIR (model: $MODEL)…"
if command -v apt-get >/dev/null; then
  sudo apt-get install -y -q cmake g++ git ffmpeg >/dev/null
fi

if [ ! -d "$DIR/.git" ]; then
  sudo mkdir -p "$DIR" && sudo chown "$(whoami)" "$DIR"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$DIR"
fi

cd "$DIR"
cmake -B build -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build build -j "$(nproc)" --target whisper-cli
sh ./models/download-ggml-model.sh "$MODEL"
chmod -R a+rX "$DIR"

echo ""
echo "✅ ears grown. Hearing test:"
./build/bin/whisper-cli -m "models/ggml-$MODEL.bin" -f samples/jfk.wav -nt --no-prints 2>/dev/null | head -1

echo ""
echo "Add to your .env, then restart the service:"
echo "  SQUIDCLAW_WHISPER_BIN=$DIR/build/bin/whisper-cli"
echo "  SQUIDCLAW_WHISPER_MODEL=$DIR/models/ggml-$MODEL.bin"
