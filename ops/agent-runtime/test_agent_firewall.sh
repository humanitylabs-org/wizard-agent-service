#!/bin/sh
# LEGACY TCP firewall test; use test_agent_sockets.sh for socket runtimes.
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
[ "$(iptables -S | grep -c -- '-NEXT')" = 0 ] && ok "no -NEXT chains left after refresh" || bad "-NEXT chains left"
# No gap while refreshing: a sandbox client hammers a host port through 15 refreshes; nothing may get through.
for k in 1 2 3 4; do
  ( n=0; while [ ! -f /tmp/stop ]; do ip netns exec sb sh -c 'echo x | nc -w 1 10.251.0.30 8923' >/dev/null 2>&1 && n=$((n+1)); done; echo "$n" >> /tmp/leaks ) &
  eval "hammer$k=\$!"
done
for i in $(seq 15); do sh "$FW" apply 8929 >/dev/null; done
touch /tmp/stop; wait "$hammer1" "$hammer2" "$hammer3" "$hammer4"
echo $(( $(paste -sd+ /tmp/leaks) )) > /tmp/leaks
[ "$(cat /tmp/leaks)" = 0 ] && ok "no connection slips through during 15 refreshes" || bad "refresh gap: $(cat /tmp/leaks) connections"
# Deterministic gap check: a shim runs every iptables call the script makes and, after each change, records any
# moment where the uplink, sandbox or listener-port guard has no INPUT hook at all.
REAL=$(command -v iptables); mkdir -p /tmp/shim; rm -f /tmp/gaps; touch /tmp/gaps
cat > /tmp/shim/iptables <<EOF
#!/bin/sh
"$REAL" "\$@"; rc=\$?
case " \$* " in *" -S "*|*" -C "*) exit \$rc ;; esac
now=\$("$REAL" -S INPUT)
echo "\$now" | grep -q -- "-s 10.250.0.0/16 -j WIZARD-AGENTS" || echo "uplink unguarded after: \$*" >> /tmp/gaps
echo "\$now" | grep -q -- "-s 10.251.0.0/16 -j WIZARD-AGENTS" || echo "sandbox unguarded after: \$*" >> /tmp/gaps
echo "\$now" | grep -q -- "--dport 8929 -j WIZARD-AGENT-PORT" || echo "port unguarded after: \$*" >> /tmp/gaps
exit \$rc
EOF
chmod +x /tmp/shim/iptables
PATH=/tmp/shim:$PATH sh "$FW" apply 8929 >/dev/null
[ ! -s /tmp/gaps ] && ok "a normal refresh never leaves a guard unhooked" || bad "refresh gap: $(head -1 /tmp/gaps)"
# A refresh interrupted after the old chains went but before the rename: the -NEXT chains are the only guard.
# The next apply must finish that refresh without a gap.
iptables -E WIZARD-AGENTS WIZARD-AGENTS-NEXT; iptables -E WIZARD-AGENT-PORT WIZARD-AGENT-PORT-NEXT
: > /tmp/gaps
PATH=/tmp/shim:$PATH sh "$FW" apply 8929 >/dev/null
[ ! -s /tmp/gaps ] && ok "no gap when recovering an interrupted refresh" || bad "recovery gap: $(head -1 /tmp/gaps)"
# Interrupted while dropping the old set: old range chain gone, old listener chain still there (with rules, or
# flushed) but no longer hooked; only the -NEXT hooks guard. Recovery must keep every guard hooked throughout.
for stale in populated flushed; do
  sh "$FW" apply 8929 >/dev/null
  iptables -E WIZARD-AGENTS WIZARD-AGENTS-NEXT; iptables -E WIZARD-AGENT-PORT WIZARD-AGENT-PORT-NEXT
  iptables -N WIZARD-AGENT-PORT
  [ "$stale" = populated ] && iptables -A WIZARD-AGENT-PORT -i lo -j RETURN && iptables -A WIZARD-AGENT-PORT -j DROP
  : > /tmp/gaps
  PATH=/tmp/shim:$PATH sh "$FW" apply 8929 >/dev/null
  [ ! -s /tmp/gaps ] && sh "$FW" check 8929 >/dev/null && [ "$(iptables -S | grep -c -- '-NEXT')" = 0 ] &&
    ok "no gap recovering a half-dropped old set ($stale listener chain)" || bad "half-dropped recovery ($stale): $(head -1 /tmp/gaps)"
done
# Interrupted while hooking in: only the listener -NEXT hook landed. The old range chain still guards; no gap.
sh "$FW" apply 8929 >/dev/null
iptables -N WIZARD-AGENT-PORT-NEXT; iptables -A WIZARD-AGENT-PORT-NEXT -j DROP; iptables -I INPUT 1 -p tcp --dport 8929 -j WIZARD-AGENT-PORT-NEXT
iptables -N WIZARD-AGENTS-NEXT; iptables -A WIZARD-AGENTS-NEXT -j DROP; iptables -I INPUT 1 -s 10.251.0.0/16 -j WIZARD-AGENTS-NEXT
: > /tmp/gaps
PATH=/tmp/shim:$PATH sh "$FW" apply 8929 >/dev/null
[ ! -s /tmp/gaps ] && sh "$FW" check 8929 >/dev/null && [ "$(iptables -S | grep -c -- '-NEXT')" = 0 ] &&
  ok "no gap recovering a half-hooked new set" || bad "half-hooked recovery: $(head -1 /tmp/gaps)"
sh "$FW" check 8929 >/dev/null && [ "$(iptables -S | grep -c -- '-NEXT')" = 0 ] && ok "recovered refresh leaves one hooked set" || bad "recovery left a bad state"
# Leftovers of a refresh interrupted while building (unhooked -NEXT chains) are cleaned; the live set stays.
iptables -N WIZARD-AGENTS-NEXT; iptables -A WIZARD-AGENTS-NEXT -j ACCEPT
sh "$FW" apply 8929 >/dev/null
[ "$(iptables -S | grep -c -- '-NEXT')" = 0 ] && sh "$FW" check 8929 >/dev/null && ok "unhooked leftovers are dropped" || bad "unhooked leftovers kept"
sh "$FW" apply 9000 >/dev/null
[ "$(iptables -S INPUT | grep -c -- '--dport 8929')" = 0 ] && ok "re-apply on a new port drops the old port hook" || bad "old port hook left"
sh "$FW" remove >/dev/null
[ "$(iptables -S | grep -c WIZARD)" = 0 ] && ok "remove leaves no WIZARD rules" || bad "remove left rules"
sh "$FW" check 8929 >/dev/null 2>&1 && bad "check fails after remove" || ok "check fails after remove"
expect "after remove: sandbox reaches host service again" sb 10.251.0.30 8923 yes
sh "$FW" apply abc >/dev/null 2>&1 && bad "non-numeric port refused" || ok "non-numeric port refused"

echo "firewall test: $pass passed, $fail failed"
[ "$fail" = 0 ]
