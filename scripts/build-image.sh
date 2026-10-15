#!/usr/bin/env bash
# Run on Thales under the shared build lock; this image contains no UX.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
tag=${1:?explicit candidate image tag required}
case "$tag" in *:latest|*:stable|*:0.2.0) printf 'Candidate tag required\n' >&2; exit 2;; esac
docker build --label org.opencontainers.image.source=https://github.com/humanitylabs-org/wizard-agent-service -t "$tag" "$here"
