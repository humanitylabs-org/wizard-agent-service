#!/bin/sh
# Install the Wizard private-access helper (wizard-private-access) on a Linux box or into a guest image.
#
#   sudo ./install.sh [--serve-upstream PORT] [--socket-group GROUP] [--root DIR] [--no-start]
#
#   --serve-upstream PORT  the 127.0.0.1 port Tailscale Serve forwards to: the Agent Service's tailnet listener
#                          (WIZARD_TAILNET_PORT, or the host port it is published on). Required the first time.
#   --socket-group GROUP   dedicated group allowed to use the socket (name or numeric gid; default: wizard, created
#                          as a system group). Add the Agent Service to it (compose group_add). Never a login
#                          user's primary group: members can sign the box out of Tailscale.
#   --root DIR             install into an image root (Try Wizard guest build): no systemctl calls, the unit is
#                          enabled by symlink and nothing is started.
#   --no-start             enable the unit but do not start it now.
#
# It never installs, starts, or signs in Tailscale; it never writes Tailscale state. Re-running is safe: an
# existing /etc/wizard-private-access.conf keeps its values unless a flag overrides them.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=""
serve_upstream=""
socket_group=""
start=1
while [ $# -gt 0 ]; do
  case "$1" in
    --serve-upstream) serve_upstream=${2:?}; shift 2 ;;
    --socket-group) socket_group=${2:?}; shift 2 ;;
    --root) root=${2:?}; shift 2 ;;
    --no-start) start=0; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
case "$serve_upstream" in ''|*[!0-9]*) [ -z "$serve_upstream" ] || { echo "install.sh: --serve-upstream must be a port" >&2; exit 2; } ;; esac
if [ -n "$serve_upstream" ] && { [ "$serve_upstream" -lt 1 ] || [ "$serve_upstream" -gt 65535 ]; }; then
  echo "install.sh: --serve-upstream must be 1-65535" >&2; exit 2
fi
case "$socket_group" in *[!A-Za-z0-9_.-]*) echo "install.sh: bad --socket-group" >&2; exit 2 ;; esac
[ -n "$root" ] || [ "$(id -u)" = 0 ] || { echo "install.sh: run as root (or use --root DIR)" >&2; exit 1; }

lib="$root/usr/local/lib/wizard-private-access"
unit_dir="$root/etc/systemd/system"
conf="$root/etc/wizard-private-access.conf"
install -d -m 0755 "$lib" "$unit_dir"
install -m 0755 "$here/wizard-private-access" "$lib/wizard-private-access"
install -m 0644 "$here/wizard-private-access.service" "$unit_dir/wizard-private-access.service"

# Config: keep what is there (values without their # comments, and any extra keys), apply flags.
current() { [ -f "$conf" ] && sed -e 's/#.*//' "$conf" | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p" | tail -n 1 || true; }
[ -n "$serve_upstream" ] || serve_upstream=$(current serve_upstream)
[ -n "$socket_group" ] || socket_group=$(current socket_group)
[ -n "$socket_group" ] || socket_group=wizard
socket_path=$(current socket)
[ -n "$socket_path" ] || socket_path=/run/wizard-private-access/sock
case "$socket_path" in *..*|*//*|/run/*/*/sock) echo "install.sh: socket in $conf must be /run/<dir>/sock" >&2; exit 2 ;; esac
case "$socket_path" in /run/*/sock) ;; *) echo "install.sh: socket in $conf must be /run/<dir>/sock" >&2; exit 2 ;; esac
case "$serve_upstream" in ''|*[!0-9]*) [ -z "$serve_upstream" ] || { echo "install.sh: serve_upstream in $conf is not a port" >&2; exit 2; } ;; esac
case "$socket_group" in *[!A-Za-z0-9_.-]*) echo "install.sh: socket_group in $conf is not a group" >&2; exit 2 ;; esac
tmp="$conf.tmp.$$"
cat > "$tmp" <<EOF
# wizard-private-access (see /usr/local/lib/wizard-private-access and the README in wizard-agent-service ops/private-access)
socket = $socket_path
socket_group = $socket_group
# 127.0.0.1 port Tailscale Serve forwards https://<this box>.<tailnet>.ts.net/ to: the Agent Service's tailnet
# listener (never a port that injects an owner identity, such as a local owner proxy).
serve_upstream = $serve_upstream
EOF
if [ -f "$conf" ]; then
  # carry over every other key (hostname, tailscale, systemctl, timeouts, ...) exactly once
  sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$conf" | grep -E '^[[:space:]]*[a-z_]+[[:space:]]*=' \
    | grep -Ev '^[[:space:]]*(socket|socket_group|serve_upstream)[[:space:]]*=' >> "$tmp" || true
fi
grep -Eq '^[[:space:]]*hostname[[:space:]]*=' "$tmp" || echo "hostname = wizard" >> "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$conf"
[ -n "$serve_upstream" ] || echo "install.sh: warning: serve_upstream is empty; POST /v1/serve will refuse until it is set" >&2

if [ -n "$root" ]; then
  install -d -m 0755 "$root/etc/systemd/system/multi-user.target.wants"
  ln -sf /etc/systemd/system/wizard-private-access.service "$root/etc/systemd/system/multi-user.target.wants/wizard-private-access.service"
  case "$socket_group" in *[!0-9]*) grep -q "^$socket_group:" "$root/etc/group" 2>/dev/null || echo "install.sh: note: group $socket_group does not exist in the image yet" >&2 ;; esac
  echo "wizard-private-access installed into $root (enabled, not started)"
  exit 0
fi

case "$socket_group" in
  *[!0-9]*) getent group "$socket_group" >/dev/null 2>&1 || groupadd --system "$socket_group" ;;
esac
systemctl daemon-reload
if [ "$start" = 1 ]; then
  systemctl enable wizard-private-access.service >/dev/null
  systemctl restart wizard-private-access.service
  echo "wizard-private-access installed and running (socket $socket_path)"
else
  systemctl enable wizard-private-access.service >/dev/null
  echo "wizard-private-access installed and enabled (not started)"
fi
