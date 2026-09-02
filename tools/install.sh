#!/usr/bin/env bash
# Installs the WhatsAbove plugin into OpenDeck's plugins directory.
# Usage: bash tools/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="${OPENDECK_PLUGINS_DIR:-$HOME/.config/opendeck/plugins}"
SRC="whatsabove.sdPlugin"

if [ ! -d "$DEST" ]; then
	echo "OpenDeck plugins directory not found at $DEST"
	echo "Set OPENDECK_PLUGINS_DIR to the correct path and re-run."
	exit 1
fi

rm -rf "${DEST%/}/${SRC}"
cp -r "$SRC" "${DEST%/}/"
echo "Installed ${SRC} -> ${DEST%/}/${SRC}"
echo
echo "Now restart OpenDeck (or reload plugins), then drag the"
echo "'ADS-B Live' action from the WhatsAbove category onto keys."
