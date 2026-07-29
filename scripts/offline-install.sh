#!/usr/bin/env bash
# Restore node_modules without contacting npmjs.org.
# Downloads the pre-bundled tarball from this repo's GitHub Releases.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG="${OFFLINE_DEPS_TAG:-offline-deps-v1}"
ASSET="${OFFLINE_DEPS_ASSET:-node_modules.tar.gz}"
URL="${OFFLINE_DEPS_URL:-https://github.com/EzZeng/redis-desktop/releases/download/${TAG}/${ASSET}}"
OUT="${ROOT}/${ASSET}"

if [ -d node_modules ] && [ -f node_modules/.package-lock.json ] || [ -d node_modules/vite ]; then
  if [ "${FORCE_OFFLINE_INSTALL:-}" != "1" ]; then
    echo "node_modules already present. Set FORCE_OFFLINE_INSTALL=1 to re-download."
    exit 0
  fi
  echo "FORCE_OFFLINE_INSTALL=1: removing existing node_modules..."
  rm -rf node_modules
fi

echo "Downloading offline dependencies from:"
echo "  $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar -o "$OUT" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$OUT" "$URL"
else
  echo "Need curl or wget to download $URL" >&2
  exit 1
fi

echo "Extracting $OUT ..."
tar -xzf "$OUT"
rm -f "$OUT"
echo "Done. node_modules is ready."
echo "Next: npm run dev"
