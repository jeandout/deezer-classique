#!/usr/bin/env bash
# Assemble l'application web dans _site/ : l'enveloppe (web/) et le code de
# recherche partagé avec l'extension (extension-classique/).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site
cp -r web/. _site/
cp extension-classique/{styles.js,background.js,bg-works.js,works.js} _site/
# Nouvelle version du cache hors ligne à chaque publication.
stamp="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
sed -i "s/classique-v1/classique-${stamp}/" _site/sw.js
echo "Site assemblé dans _site/ ($(ls _site | wc -l) éléments, version ${stamp})"
