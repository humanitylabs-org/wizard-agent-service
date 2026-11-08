#!/bin/bash
set -uo pipefail
export PATH=/srv/work/tools/node-v22/bin:$PATH
cd /srv/work/chats-cpu-main
git rev-parse HEAD; hostname; node --version
npm ci --silent || exit 1
python3 -m venv .import-venv && .import-venv/bin/pip install -q "PyYAML>=6.0.2,<7" "python-dotenv>=1.0,<2" || exit 1
export WIZARD_IMPORT_PYTHON=$PWD/.import-venv/bin/python
rc=0
$WIZARD_IMPORT_PYTHON tests/test_supervisor_plugin.py || rc=1
python3 ops/agent-runtime/test_agent_runtime.py || rc=1
node --test tests/chats-list-cpu.node.mjs tests/speed-meter.node.mjs tests/agent-service-cpu.node.mjs tests/chats-list-head.node.mjs tests/chats-head-runtime-parity.node.mjs tests/chats-list-truth.node.mjs tests/session-list-cache.node.mjs tests/session-list-cache-http.node.mjs tests/chats-list-poll.node.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^not ok" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
REQUIRE_ROLLBACK_REHEARSAL=1 npm test 2>&1 | tail -40 ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo SUITE_EXIT=$rc
exit $rc
