#!/usr/bin/env bash
set -euo pipefail

ROOT="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$ROOT"

version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' metadata.json | head -1)"
version="${version:-dev}"
name="nome-onscreen-keyboard-v${version}"
dist_dir="$ROOT/dist"
stage="$dist_dir/$name"

rm -rf "$stage"
mkdir -p "$stage"

install -m 0755 "Install Nome - Onscreen Keyboard.sh" "$stage/Install Nome - Onscreen Keyboard.sh"
install -m 0755 "Uninstall Nome - Onscreen Keyboard.sh" "$stage/Uninstall Nome - Onscreen Keyboard.sh"
install -m 0755 install.sh "$stage/install.sh"
install -m 0755 uninstall.sh "$stage/uninstall.sh"

install -m 0644 README-FIRST.txt "$stage/README-FIRST.txt"
install -m 0644 README.md "$stage/README.md"
install -m 0644 metadata.json "$stage/metadata.json"
install -m 0644 extension.js "$stage/extension.js"
install -m 0644 predictor.js "$stage/predictor.js"
install -m 0644 stylesheet.css "$stage/stylesheet.css"
install -m 0644 nome-onscreen-keyboard.desktop "$stage/nome-onscreen-keyboard.desktop"
install -m 0644 seed-bigrams.txt "$stage/seed-bigrams.txt"

if [[ -f wordlist.txt ]]; then
    install -m 0644 wordlist.txt "$stage/wordlist.txt"
fi

if command -v zip >/dev/null 2>&1; then
    ( cd "$dist_dir" && rm -f "$name.zip" && zip -qr "$name.zip" "$name" )
    echo "Created $dist_dir/$name.zip"
else
    ( cd "$dist_dir" && tar -czf "$name.tar.gz" "$name" )
    echo "zip not found; created $dist_dir/$name.tar.gz instead"
fi
