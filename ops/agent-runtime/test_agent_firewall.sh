#!/bin/sh
# Functional test of agent-firewall.sh inside a privileged throwaway container (needs NET_ADMIN + netns).
# Two fake agent namespaces: "up" at 10.250.0.17 (an uplink sidecar) and "sb" at 10.251.0.17 (a sandbox agent),
# plus "pub" at 192.0.2.17 (stands in for the public interface). The "host" is the container's root namespace.
set -eu
apk add -q iptables iproute2 netcat-openbsd >/dev/null
FW=/fw/agent-firewall.sh
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }

mkns() { # name host-ip ns-ip prefix
  ip netns add "$1"
  ip link add "h-$1" type veth peer name "n-$1"
  ip link set "n-$1" netns "$1"
  ip addr add "$2/$4" dev "h-$1"; ip link set "h-$1" up
  ip netns exec "$1" ip addr add "$3/$4" dev "n-$1"
  ip netns exec "$1" ip link set "n-$1" up
  ip netns exec "$1" ip link set lo up
  ip netns exec "$1" ip route add default via "$2"
}
mkns up 10.250.0.30 10.250.0.17 28
mkns sb 10.251.0.30 10.251.0.17 28
mkns pub 192.0.2.30 192.0.2.17 28

# Host listeners: the agent listener (8929) and some other host service (8923).
for port in 8929 8923; do ( while true; do echo hi | nc -l -p "$port" >/dev/null 2>&1; done ) & done
sleep 1
can() { ip netns exec "$1" sh -c "echo x | nc -w 2 $2 $3" >/dev/null 2>&1; }
expect() { # name ns dst port want(yes|no)
  if can "$2" "$3" "$4"; then got=yes; else got=no; fi
  [ "$got" = "$5" ] && ok "$1" || bad "$1 (got $got)"
}

expect "before: sandbox reaches host service (baseline is open)" sb 10.251.0.30 8923 yes
sh "$FW" apply 8929
expect "uplink -> listener accepted" up 10.250.0.30 8929 yes
expect "uplink -> other host port dropped" up 10.250.0.30 8923 no
expect "sandbox -> listener dropped" sb 10.251.0.30 8929 no
expect "sandbox -> other host port dropped" sb 10.251.0.30 8923 no
expect "public -> listener dropped" pub 192.0.2.30 8929 no
expect "public -> other host port untouched" pub 192.0.2.30 8923 yes
if echo x | nc -w 2 127.0.0.1 8929 >/dev/null 2>&1; then ok "loopback -> listener accepted"; else bad "loopback -> listener"; fi
# Host-initiated connection to an agent still gets its replies (the Service reaching an edge relay).
ip netns exec up sh -c 'echo hi | nc -l -p 7000 >/dev/null 2>&1 &'; sleep 0.5
if echo x | nc -w 2 10.250.0.17 7000 >/dev/null 2>&1; then ok "host -> uplink replies allowed"; else bad "host -> uplink replies"; fi

sh "$FW" check 8929 >/dev/null && ok "check passes when applied" || bad "check when applied"
before=$(iptables -S | wc -l); sh "$FW" apply 8929 >/dev/null; after=$(iptables -S | wc -l)
[ "$before" = "$after" ] && ok "apply is idempotent ($after rules)" || bad "apply idempotent ($before -> $after)"
sh "$FW" apply 9000 >/dev/null
[ "$(iptables -S INPUT | grep -c -- '--dport 8929')" = 0 ] && ok "re-apply on a new port drops the old port hook" || bad "old port hook left"
sh "$FW" remove >/dev/null
[ "$(iptables -S | grep -c WIZARD)" = 0 ] && ok "remove leaves no WIZARD rules" || bad "remove left rules"
sh "$FW" check 8929 >/dev/null 2>&1 && bad "check fails after remove" || ok "check fails after remove"
expect "after remove: sandbox reaches host service again" sb 10.251.0.30 8923 yes
sh "$FW" apply abc >/dev/null 2>&1 && bad "non-numeric port refused" || ok "non-numeric port refused"

echo "firewall test: $pass passed, $fail failed"
[ "$fail" = 0 ]
