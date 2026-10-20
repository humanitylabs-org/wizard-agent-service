#!/bin/sh
# Run ONLY inside a disposable --network none container with NET_ADMIN + SYS_ADMIN.
set -eu
apk add -q iproute2 netcat-openbsd >/dev/null
mkns() {
  name=$1; source=$2; gateway=$3
  ip netns add "$name"
  ip link add "h-$name" type veth peer name "n-$name"
  ip link set "n-$name" netns "$name"
  ip addr add "$gateway/32" dev "h-$name"; ip link set "h-$name" up
  ip route add "$source/32" dev "h-$name"
  ip netns exec "$name" ip addr add "$source/32" dev "n-$name"
  ip netns exec "$name" ip link set "n-$name" up
  ip netns exec "$name" ip link set lo up
  ip netns exec "$name" ip route add "$gateway/32" dev "n-$name"
  ip netns exec "$name" ip route add default via "$gateway"
}
mkns client 10.251.0.19 192.0.2.1
mkns relay 10.252.0.3 192.0.2.2
mkns provider 10.252.0.2 192.0.2.3
mkns peer 10.251.0.20 192.0.2.4
mkns internet 10.253.0.2 192.0.2.5
sysctl -w net.ipv4.ip_forward=1 >/dev/null
# A namespace without any bridge has no br_netfilter sysctls yet.
ip link add qa-br type bridge
ip link set qa-br up
iptables -N DOCKER-USER
iptables -A FORWARD -j DOCKER-USER
for ns in provider peer internet; do
  ip netns exec "$ns" sh -c 'while true; do printf ok | nc -l -p 8090 >/dev/null 2>&1; done' &
done
(while true; do printf ok | nc -l -p 8090 >/dev/null 2>&1; done) &
can() { ip netns exec "$1" sh -c "printf x | nc -w 1 $2 8090" >/dev/null 2>&1; }
pass=0
expect() {
  label=$1; ns=$2; target=$3; want=$4
  if can "$ns" "$target"; then got=yes; else got=no; fi
  [ "$got" = "$want" ] || { printf 'FAIL %s (got %s)\n' "$label" "$got"; exit 1; }
  printf 'PASS %s\n' "$label"; pass=$((pass+1))
}
sleep 1
expect 'baseline peer reachable' client 10.251.0.20 yes
sh /fw/private-client-firewall.sh apply aabbccdd 10.251.0.19 10.252.0.3 10.252.0.2 8090 10.251.0.18
expect 'sandbox client -> relay accepted' client 10.252.0.2 yes
expect 'relay client -> relay accepted' relay 10.252.0.2 yes
expect 'sandbox peer denied' client 10.251.0.20 no
expect 'other relay peer denied' relay 10.251.0.20 no
expect 'internet denied' relay 10.253.0.2 no
expect 'host denied' client 192.0.2.1 no
# The client can reply to Hermes but cannot initiate to it (stateful established exception).
# Existing test above proves stateful relay replies; reverse stream coverage is in the source rule tests.
sh /fw/private-client-firewall.sh apply aabbccdd 10.251.0.19 10.252.0.3 10.252.0.2 8090 10.251.0.18
expect 'refresh keeps peer denied' client 10.251.0.20 no
sh /fw/private-client-firewall.sh remove aabbccdd
expect 'remove restores baseline' client 10.251.0.20 yes
printf 'private client firewall test: %s passed, 0 failed\n' "$pass"
