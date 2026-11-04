#!/bin/bash
# SUBMIT ON THE DURABLE LIGHT LANE. Do not execute on a control-plane host.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
revision=818c13be1dc4fd28987e1e881a9408224afd4535
image="wizard-hermes-import:${revision:0:12}"
python3 -c 'import json,pathlib; p=pathlib.Path("source/install-stamp.json"); p.write_text(json.dumps({"schemaVersion":2,"commit":"818c13be1dc4fd28987e1e881a9408224afd4535","distribution":"docker","source":"wizard-import-packaging","updateMechanism":"external"})+"\n")'
docker_context=${WIZARD_IMPORT_DOCKER_CONTEXT:-colima}
docker --context "$docker_context" build --platform linux/amd64 --build-arg "HERMES_REVISION=$revision" -t "$image" .
docker --context "$docker_context" image inspect "$image" --format '{{.Id}} {{json .Config.Labels}}'
# No push or multi-GB save to the VPS. Parent chooses approved transport after
# source-parity/API/tools validation. The image remains on ThalesMedia's daemon.
