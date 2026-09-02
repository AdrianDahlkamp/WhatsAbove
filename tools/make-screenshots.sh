#!/usr/bin/env bash
# Regenerate the README preview images in docs/ (nearest / both / count / offline
# plus a 4-up montage). Requires: node, rsvg-convert, ImageMagick (magick).
#
# Usage: bash tools/make-screenshots.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/docs"
TMP="$(mktemp -d)"
PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]:-}"; do
    [[ -n "$p" ]] && kill "$p" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$OUT"

# --- deterministic data source: one full-data plane nearest + a 46-plane fleet ---
python3 - "$TMP/fleet.json" <<'PY'
import json, random, sys
random.seed(42)
calls = ['TEST123','DLH441','BAW118','AFR776','UAL204','KLM622','EZY909','RYR333','LX4402','SWR221',
         'QFA12','JBU655','AAL77','UAE888','SIA316','THY901','QTR204','CCA101','DAL330','VIR801']
ac = [{'hex':'a46d6f','flight':' TEST123','alt_baro':36000,'gs':460,'track':90,
       'lat':54.99592,'lon':8.46155,'seen':0,'rssi':-70}]
for i in range(46):
    a = {'hex':'%06x' % random.getrandbits(24), 'flight':'  %s' % random.choice(calls),
         'gs': random.randint(280,490), 'track': random.randint(0,359), 'seen':0,
         'rssi': random.randint(-85,-55)}
    if random.random() < 0.8:
        a['alt_baro'] = random.choice([0,12000,18500,24000,31000,36000,39000])
    if random.random() < 0.7:
        a['lat'] = round(54.9 + random.uniform(-0.4,0.4), 5)
        a['lon'] = round(8.31 + random.uniform(-0.6,0.6), 5)
    ac.append(a)
open(sys.argv[1], 'w').write(json.dumps(ac))
PY

DATA_PORT=12990
AC="$(cat "$TMP/fleet.json")" node tools/mock-data-server.js "$DATA_PORT" >"$TMP/data.log" 2>&1 &
PIDS+=($!)
sleep 0.5

capture() { # <tag> <mode> <dataHost>
  local tag="$1" mode="$2" host="$3"
  local ws_port
  ws_port="$(python3 -c 'import random; print(random.randint(20000, 30000))')"
  rm -rf tools/out
  node tools/mock-opendeck.js "$ws_port" "{\"mode\":\"$mode\",\"dataHost\":\"$host\",\"refresh\":1}" >"$TMP/mock-$tag.log" 2>&1 &
  local mp=$!
  sleep 0.4
  node de.adrianvd.whatsabove.sdPlugin/plugin.js -port "$ws_port" \
    -pluginUUID de.adrianvd.whatsabove.sdPlugin -registerEvent registerPlugin -info "{}" \
    >"$TMP/plugin-$tag.log" 2>&1 &
  local pp=$!
  sleep 4
  kill "$mp" "$pp" 2>/dev/null || true
  # take the last rendered frame (settled state); the mock writes into tools/out/
  local src
  src="$(ls tools/out/img-*.svg 2>/dev/null | sort | tail -1 || true)"
  if [[ -z "${src:-}" ]]; then
    echo "  ! no image captured for $tag" >&2
    return 1
  fi
  cp "$src" "$TMP/$tag.svg"
  rsvg-convert -w 512 -o "$OUT/preview-$tag.png" "$TMP/$tag.svg"
  echo "  preview-$tag.png"
}

echo "Capturing previews (data: http://127.0.0.1:$DATA_PORT) …"
capture nearest nearest "http://127.0.0.1:$DATA_PORT"
capture both    both    "http://127.0.0.1:$DATA_PORT"
capture count   count   "http://127.0.0.1:$DATA_PORT"
capture offline nearest "http://127.0.0.1:1"   # dead host -> offline state

# 4-up montage for the README header (dark backdrop, 24px gutters)
magick \
  "$OUT/preview-nearest.png" \
  "$OUT/preview-both.png" \
  "$OUT/preview-count.png" \
  "$OUT/preview-offline.png" \
  -background '#10141a' -bordercolor '#10141a' -border 24 \
  +append "$OUT/preview-montage.png"
echo "  preview-montage.png"
echo "Done: $OUT/preview-*.png"
