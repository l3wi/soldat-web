#!/bin/sh
# Own the UFW ruleset on a dedicated VPS; do not run on a shared-purpose host.
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root on the dedicated game VPS." >&2
    exit 1
fi
command -v ufw >/dev/null 2>&1 || { echo "Install ufw first." >&2; exit 1; }
# UFW must manage IPv6 too; otherwise a public AAAA record could bypass policy.
if ! grep -Eq '^[[:space:]]*IPV6=yes[[:space:]]*$' /etc/default/ufw; then
    echo "Set IPV6=yes in /etc/default/ufw before running this script." >&2
    exit 1
fi

# Reset removes stale broad allow rules; repeat runs produce the same policy.
# Keep the provider console and an existing SSH session open during this change.
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment 'Key-only SSH with connection rate limiting'
ufw allow 443/tcp comment 'Soldat HTTPS and WSS'
ufw allow 443/udp comment 'Reserved for future WebTransport; no current UDP listener'
# Avoid per-packet firewall logs becoming a disk/CPU amplifier under attack.
ufw logging off
ufw --force enable
ufw status verbose
