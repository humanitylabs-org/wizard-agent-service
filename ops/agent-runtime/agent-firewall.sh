#!/bin/sh
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
#   agent-firewall.sh apply [port]   install or refresh the rules
#   agent-firewall.sh check [port]   print the rules (exit 1 when any hook is missing)
#   agent-firewall.sh remove         take them out again
set -eu
RANGE=WIZARD-AGENTS
LISTEN=WIZARD-AGENT-PORT
UPLINK=10.250.0.0/16
SANDBOX=10.251.0.0/16
PORT=${2:-8929}
case "$PORT" in *[!0-9]*|'') echo "port must be a number" >&2; exit 2 ;; esac

range_hook() { iptables -C INPUT -s "$1" -j "$RANGE" 2>/dev/null; }
port_hook() { iptables -C INPUT -p tcp --dport "$PORT" -j "$LISTEN" 2>/dev/null; }

remove_all() {
  # Every INPUT jump into either chain, whatever port it was installed with.
  iptables -S INPUT | grep -E -- "-j ($RANGE|$LISTEN)\$" | sed 's/^-A /-D /' | while read -r rule; do
    # shellcheck disable=SC2086
    iptables $rule
  done
  for chain in "$RANGE" "$LISTEN"; do
    iptables -F "$chain" 2>/dev/null || true
    iptables -X "$chain" 2>/dev/null || true
  done
}

case "${1:-}" in
  apply)
    remove_all
    iptables -N "$RANGE"
    iptables -A "$RANGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -A "$RANGE" -s "$UPLINK" -p tcp --dport "$PORT" -m conntrack --ctstate NEW -j ACCEPT
    iptables -A "$RANGE" -j DROP
    iptables -N "$LISTEN"
    iptables -A "$LISTEN" -i lo -j RETURN
    iptables -A "$LISTEN" -s "$UPLINK" -j RETURN
    iptables -A "$LISTEN" -j DROP
    # Inserted at the top in reverse, so the order is: uplink range, sandbox range, listener port guard.
    iptables -I INPUT 1 -p tcp --dport "$PORT" -j "$LISTEN"
    iptables -I INPUT 1 -s "$SANDBOX" -j "$RANGE"
    iptables -I INPUT 1 -s "$UPLINK" -j "$RANGE"
    echo "agent firewall: applied (listener port $PORT)"
    ;;
  check)
    iptables -S "$RANGE"
    iptables -S "$LISTEN"
    range_hook "$UPLINK" && range_hook "$SANDBOX" && port_hook && echo "agent firewall: hooked (listener port $PORT)"
    ;;
  remove)
    remove_all
    echo "agent firewall: removed"
    ;;
  *)
    echo "usage: $0 apply [port] | check [port] | remove" >&2
    exit 2
    ;;
esac
