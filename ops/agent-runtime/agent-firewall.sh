#!/bin/sh
# LEGACY/OPTIONAL: TCP-runtime guard only. Socket-based restricted installs do not install/run this.
# Retained for existing boxes; never remove live rules automatically. See docs/restricted-agent-runtime.md.
# Host firewall for restricted agents (run as root; idempotent).
#
# Restricted agents' sidecars sit on per-agent uplink networks carved from 10.250.0.0/16; the agents themselves
# sit on sandbox networks from 10.251.0.0/16, where the host has no address. Two chains follow from that:
#   WIZARD-AGENTS      traffic from either agent range to the host: only NEW tcp from the uplink range to the
#                      agent-only listener (WIZARD_AGENT_PORT, default 8929) is accepted, plus replies to
#                      connections the host opened (the Service reaching an agent through its edge relay).
#                      Everything else from those ranges is dropped.
#   WIZARD-AGENT-PORT  the listener binds 0.0.0.0, so connections to its port from anywhere except loopback
#                      or the uplink range are dropped (public interface included).
#
# A refresh never opens a gap: the new chains are built and hooked in before the old hooks and chains go, then
# renamed into place (rules follow a renamed chain).
#
#   agent-firewall.sh apply [port]   install or refresh the rules
#   agent-firewall.sh check [port]   print the rules (exit 1 when any hook is missing)
#   agent-firewall.sh remove         take them out again
set -eu
RANGE=WIZARD-AGENTS
LISTEN=WIZARD-AGENT-PORT
NEXT=-NEXT
UPLINK=10.250.0.0/16
SANDBOX=10.251.0.0/16
PORT=${2:-8929}
case "$PORT" in *[!0-9]*|'') echo "port must be a number" >&2; exit 2 ;; esac

range_hook() { iptables -C INPUT -s "$1" -j "$RANGE" 2>/dev/null; }
port_hook() { iptables -C INPUT -p tcp --dport "$PORT" -j "$LISTEN" 2>/dev/null; }

chain_exists() { iptables -S "$1" >/dev/null 2>&1; }
next_complete() { # the chain's -NEXT copy carries every INPUT hook that chain needs
  if [ "$1" = "$RANGE" ]; then
    iptables -C INPUT -s "$UPLINK" -j "$RANGE$NEXT" 2>/dev/null && iptables -C INPUT -s "$SANDBOX" -j "$RANGE$NEXT" 2>/dev/null
  else
    iptables -S INPUT | grep -q -E -- "-j $LISTEN$NEXT\$"
  fi
}

# An interrupted refresh can leave -NEXT chains behind, sometimes as the only live guard. Each chain is settled on
# its own, by the hooks actually in place: a -NEXT copy that carries every hook its chain needs is complete, so the
# old chain (whatever is left of it) goes and the copy is renamed into place; a -NEXT copy missing a hook was still
# being hooked in, which means the old chain was untouched and still guards, so the copy goes. Either way a hook is
# only removed while a complete one guards the same traffic.
recover() {
  for chain in "$RANGE" "$LISTEN"; do
    chain_exists "$chain$NEXT" || continue
    if next_complete "$chain"; then
      drop_chains "$chain"
      iptables -E "$chain$NEXT" "$chain"
    else
      drop_chains "$chain$NEXT"
    fi
  done
}

drop_chains() { # chain names: every INPUT jump into them (whatever port), then the chains themselves
  for chain in "$@"; do
    iptables -S INPUT | grep -E -- "-j $chain\$" | sed 's/^-A /-D /' | while read -r rule; do
      # shellcheck disable=SC2086
      iptables $rule
    done
    iptables -F "$chain" 2>/dev/null || true
    iptables -X "$chain" 2>/dev/null || true
  done
}

case "${1:-}" in
  apply)
    recover                                           # leftovers of an interrupted refresh
    iptables -N "$RANGE$NEXT"
    iptables -A "$RANGE$NEXT" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -A "$RANGE$NEXT" -s "$UPLINK" -p tcp --dport "$PORT" -m conntrack --ctstate NEW -j ACCEPT
    iptables -A "$RANGE$NEXT" -j DROP
    iptables -N "$LISTEN$NEXT"
    iptables -A "$LISTEN$NEXT" -i lo -j RETURN
    iptables -A "$LISTEN$NEXT" -s "$UPLINK" -j RETURN
    iptables -A "$LISTEN$NEXT" -j DROP
    # Inserted at the top in reverse, so the order is: uplink range, sandbox range, listener port guard.
    iptables -I INPUT 1 -p tcp --dport "$PORT" -j "$LISTEN$NEXT"
    iptables -I INPUT 1 -s "$SANDBOX" -j "$RANGE$NEXT"
    iptables -I INPUT 1 -s "$UPLINK" -j "$RANGE$NEXT"
    drop_chains "$RANGE" "$LISTEN"                    # the old set; the new one is already in force
    iptables -E "$RANGE$NEXT" "$RANGE"
    iptables -E "$LISTEN$NEXT" "$LISTEN"
    echo "agent firewall: applied (listener port $PORT)"
    ;;
  check)
    iptables -S "$RANGE"
    iptables -S "$LISTEN"
    range_hook "$UPLINK" && range_hook "$SANDBOX" && port_hook && echo "agent firewall: hooked (listener port $PORT)"
    ;;
  remove)
    drop_chains "$RANGE" "$LISTEN" "$RANGE$NEXT" "$LISTEN$NEXT"
    echo "agent firewall: removed"
    ;;
  *)
    echo "usage: $0 apply [port] | check [port] | remove" >&2
    exit 2
    ;;
esac
