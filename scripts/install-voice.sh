#!/usr/bin/env bash
# Grows SquidClaw's built-in voice on this machine.
#
# Piper (MIT): local neural text-to-speech — prebuilt binary, open voice
# models, runs on CPU in real time. Two voices are installed: Arabic
# (ar_JO kareem) and English (en_US lessac). No API, no cloud; the voice
# is made on the box. Companion of scripts/install-ears.sh.
#
#   bash scripts/install-voice.sh
set -euo pipefail

DIR="${SQUIDCLAW_PIPER_DIR:-/opt/piper}"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
VOICES="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"

echo "🗣️ growing a voice in $DIR…"
sudo mkdir -p "$DIR/voices" && sudo chown -R "$(whoami)" "$DIR"

if [ ! -x "$DIR/piper/piper" ]; then
  curl -fsSL "$PIPER_URL" | tar -xz -C "$DIR"
fi

fetch_voice() { # lang path name
  local f="$DIR/voices/$3.onnx"
  [ -f "$f" ] || curl -fsSL -o "$f" "$VOICES/$2/$3.onnx"
  [ -f "$f.json" ] || curl -fsSL -o "$f.json" "$VOICES/$2/$3.onnx.json"
}
fetch_voice ar "ar/ar_JO/kareem/medium" "ar_JO-kareem-medium"
fetch_voice en "en/en_US/lessac/medium" "en_US-lessac-medium"
chmod -R a+rX "$DIR"

echo ""
echo "✅ voice grown. Speaking test (Arabic):"
echo "مرحبا، أنا سكويدكلو" | "$DIR/piper/piper" -m "$DIR/voices/ar_JO-kareem-medium.onnx" -f /tmp/sq-voice-test.wav -q && ls -la /tmp/sq-voice-test.wav

echo ""
echo "Add to your .env, then restart the service:"
echo "  SQUIDCLAW_PIPER_BIN=$DIR/piper/piper"
echo "  SQUIDCLAW_PIPER_VOICE_AR=$DIR/voices/ar_JO-kareem-medium.onnx"
echo "  SQUIDCLAW_PIPER_VOICE_EN=$DIR/voices/en_US-lessac-medium.onnx"
