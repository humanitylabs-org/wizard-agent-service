#!/usr/bin/env bash
# Build the Wizard shell image: this repo's Agent Service + wizard-ux's web/ folder.
#   scripts/build-image.sh <path-to-wizard-ux-checkout> [image-tag]
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
ux=${1:?path to a wizard-ux checkout}
tag=${2:-ghcr.io/humanitylabs-org/wizard-shell:dev}
rm -rf "$here/ux" && cp -R "$ux/web" "$here/ux"
git -C "$ux" rev-parse --short HEAD > "$here/ux/UX_COMMIT" 2>/dev/null || true
trap 'rm -rf "$here/ux"' EXIT
docker build -t "$tag" "$here"
echo "built $tag"
