#!/bin/sh
# Which commits the required `gitleaks` check scans (.github/workflows/secret-scan.yml): only the change in front
# of it, never another branch's history (humanitylabs-org/wizard-ux#887 rule 2: a finding on someone else's branch must not block
# your PR). Prints one git revision range for `gitleaks git --log-opts`, or nothing when there is nothing to scan.
#
#   pull_request                  PR_BASE..PR_HEAD          the PR's own commits
#   push to the default branch    PUSH_AFTER                that branch's whole history (what every box builds on)
#   push to any other ref         origin/DEFAULT..AFTER     the commits that ref has and the default branch lacks
#   branch or tag deleted         (nothing)
#
# Every branch's full history is still scanned by the daily `history-audit` job in the same workflow.
# Inputs come from the event (env), never from the shell: EVENT, PR_BASE, PR_HEAD, PUSH_REF, PUSH_AFTER,
# DEFAULT_BRANCH. Exits non-zero (and prints nothing) on a malformed SHA or a commit missing from the clone, so a
# broken range fails the check instead of scanning nothing.
set -eu
ZERO=0000000000000000000000000000000000000000
sha() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$' || { echo "secret-scan-range: not a commit SHA: '$1'" >&2; exit 2; }; }
have() { git cat-file -e "$1^{commit}" 2>/dev/null || { echo "secret-scan-range: commit $1 is not in this clone" >&2; exit 3; }; }
case "${EVENT:-}" in
  pull_request|pull_request_target)
    sha "${PR_BASE:-}"; sha "${PR_HEAD:-}"; have "$PR_BASE"; have "$PR_HEAD"
    echo "$PR_BASE..$PR_HEAD" ;;
  push)
    sha "${PUSH_AFTER:-}"
    [ "$PUSH_AFTER" = "$ZERO" ] && exit 0            # deleted: nothing new to scan
    have "$PUSH_AFTER"
    : "${DEFAULT_BRANCH:?}"
    if [ "${PUSH_REF:-}" = "refs/heads/$DEFAULT_BRANCH" ]; then
      echo "$PUSH_AFTER"
    else
      have "origin/$DEFAULT_BRANCH"
      echo "origin/$DEFAULT_BRANCH..$PUSH_AFTER"
    fi ;;
  *) echo "secret-scan-range: unsupported event '${EVENT:-}'" >&2; exit 4 ;;
esac
