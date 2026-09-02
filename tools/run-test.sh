#!/usr/bin/env bash
# Integration test: mock OpenDeck + plugin + real Pi data.
# Usage: tools/run-test.sh [settingsJson]
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-12399}"
SETTINGS="${1:-{\"mode\":\"both\",\"dataHost\":\"http://10.12.95.235:8080\",\"openUrl\":\"http://10.12.95.235:8080/\",\"refresh\":3}}"

rm -rf tools/out && mkdir -p tools/out
KEYUP_AFTER_MS="${KEYUP_AFTER_MS:-6000}"

node tools/mock-opendeck.js "$PORT" "$SETTINGS" > tools/out/mock.log 2>&1 &
MOCK_PID=$!
sleep 0.5

node whatsabove.sdPlugin/plugin.js -port "$PORT" -pluginUUID whatsabove -registerEvent registerPlugin -info '{}' > tools/out/plugin.log 2>&1 &
PLUGIN_PID=$!

sleep "${SLEEP:-15}"

kill "$MOCK_PID" "$PLUGIN_PID" 2>/dev/null
wait 2>/dev/null

echo "===== mock.log ====="
cat tools/out/mock.log
echo "===== plugin.log ====="
cat tools/out/plugin.log
echo "===== images ====="
ls tools/out/ | grep -v log || true
