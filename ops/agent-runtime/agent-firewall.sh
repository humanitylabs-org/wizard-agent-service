#!/bin/sh
# Host firewall for restricted agents (run as root; idempotent).
#
# Restricted agents' sidecars sit on per-agent uplink networks carved from 10.250.0.0/16; the agents themselves
# sit on sandbox networks from 10.251.0.0/16 where the host has no address. From those ranges the host accepts
# exactly one thing: new TCP connections to the Agent Service's agent-only listener (default 8924) from the
# uplink range. Replies to connections the host opened (the Service reaching an agent through its edge relay)
# stay allowed. Everything else from either range to the host is dropped.
#
#   agent-firewall.sh apply [port]   install or refresh the rules
#   agent-firewall.sh check          print the rules (exit 1 when missing)
#   agent-firewall.sh remove         take them out again
set -eu
CHAIN=WIZARD-AGENTS
UPLINK=10.250.0.0/16
SANDBOX=10.251.0.0/16
PORT=${2:-8924}

hook() { iptables -C INPUT -s "$1" -j "$CHAIN" 2>/dev/null; }

case "${1:-}" in
  apply)
    iptables -N "$CHAIN" 2>/dev/null || true
    iptables -F "$CHAIN"
    iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -A "$CHAIN" -s "$UPLINK" -p tcp --dport "$PORT" -m conntrack --ctstate NEW -j ACCEPT
    iptables -A "$CHAIN" -j DROP
    for net in "$UPLINK" "$SANDBOX"; do hook "$net" || iptables -I INPUT 1 -s "$net" -j "$CHAIN"; done
    echo "agent firewall: applied (listener port $PORT)"
    ;;
  check)
    iptables -S "$CHAIN"
    hook "$UPLINK" && hook "$SANDBOX" && echo "agent firewall: hooked"
    ;;
  remove)
    for net in "$UPLINK" "$SANDBOX"; do while hook "$net"; do iptables -D INPUT -s "$net" -j "$CHAIN"; done; done
    iptables -F "$CHAIN" 2>/dev/null || true
    iptables -X "$CHAIN" 2>/dev/null || true
    echo "agent firewall: removed"
    ;;
  *)
    echo "usage: $0 apply [port] | check | remove" >&2
    exit 2
    ;;
esac
