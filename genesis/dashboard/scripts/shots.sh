#!/bin/sh
# Screenshots of the fixture dashboard with the Chrome that is already installed (nothing is downloaded).
#   sh scripts/shots.sh <base url> <out dir> <name> <hash path> [desktop height] [phone height]
base="$1"; out="$2"; name="$3"; route="$4"; dh="${5:-1400}"; ph="${6:-2600}"
mkdir -p "$out"
for spec in "desktop 1440,$dh" "phone 390,$ph"; do
    set -- $spec
    timeout 90 google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size="$2" --timeout=5000 \
        --screenshot="$out/$name-$1.png" "$base/#$route" >/dev/null 2>&1
done
ls "$out" | grep "^$name-"
