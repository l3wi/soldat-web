#!/bin/sh
# Certbot deploy hook for the explicitly named soldat-server certificate only.
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
    echo "Certificate deployment must run as root." >&2
    exit 1
fi
: "${RENEWED_LINEAGE:?Certbot must provide RENEWED_LINEAGE}"
# Other certificates on this host must never replace the game server identity.
[ "$RENEWED_LINEAGE" = /etc/letsencrypt/live/soldat-server ] || exit 0

# Serialize deploy hooks and publish the key/certificate pair in one symlink swap.
exec 9>/run/lock/soldat-tls-deploy.lock
flock -x 9
install -d -o root -g soldat -m 0750 /etc/soldat/tls
generation=$(mktemp -d /etc/soldat/tls/generation.XXXXXXXX)
link="$generation.link"
published=0
trap 'rm -f "$link"; if [ "$published" -eq 0 ]; then rm -f "$generation/key.pem" "$generation/fullchain.pem"; rmdir "$generation"; fi' EXIT
trap 'exit 1' HUP INT TERM
chown root:soldat "$generation"
chmod 0750 "$generation"
install -o root -g soldat -m 0640 "$RENEWED_LINEAGE/privkey.pem" "$generation/key.pem"
install -o root -g soldat -m 0640 "$RENEWED_LINEAGE/fullchain.pem" "$generation/fullchain.pem"
ln -s "${generation##*/}" "$link"
mv -Tf "$link" /etc/soldat/tls/current
published=1

# Initial issuance precedes unit installation; renewal reloads an active service.
if systemctl is-active --quiet soldat-server.service; then
    systemctl reload soldat-server.service
else
    echo "TLS files deployed; soldat-server is not active, so reload was skipped."
fi
