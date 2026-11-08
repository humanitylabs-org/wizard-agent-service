#!/bin/bash
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH
export TMPDIR=/Volumes/ThalesMedia/tmp/phone-setup-land
export npm_config_cache=/Volumes/ThalesMedia/QA/phone-setup/npm-cache
export PIP_CACHE_DIR=/Volumes/ThalesMedia/QA/phone-setup/pip-cache
mkdir -p "$TMPDIR" out
python3 verify-snapshot.py > out/source-verify.log 2>&1
test "$(git rev-parse HEAD)" = ef878276507d1bae4f94f66b4cec4f4e88f037f7
git cat-file -e 859c548d43081a5e28a37680e796d07041971601^{commit}
# This pre-existing tracked symlink points to a developer's dependency directory, not source.
if test -L node_modules; then rm node_modules; fi
npm ci --no-audit --no-fund > out/npm-ci.log 2>&1
REQUIRE_ROLLBACK_REHEARSAL=1 npm test > out/unit-suite.log 2>&1
python3 -m unittest discover -s ops/private-access/tests -v > out/helper-tests.log 2>&1
python3 -m venv out/provider-venv
out/provider-venv/bin/python -m pip install fastapi==0.133.1 httpx==0.28.1 > out/provider-deps.log 2>&1
out/provider-venv/bin/python tests/test_account_lifecycle.py > out/account-lifecycle.log 2>&1
out/provider-venv/bin/python tests/test_provider_accounts.py > out/provider-accounts.log 2>&1
node --test tests/provider-accounts.node.mjs > out/provider-accounts-node.log 2>&1
python3 verify-snapshot.py --after-deps >> out/source-verify.log 2>&1
python3 -c 'import json; from pathlib import Path; d=json.loads(Path("source-manifest.json").read_text()); print("PASS",d["commit"]); [print("\n"+name+"\n"+Path("out",name).read_text()[-1300:]) for name in ["unit-suite.log","helper-tests.log","account-lifecycle.log","provider-accounts.log","provider-accounts-node.log"]]' > out/final-receipt.txt
