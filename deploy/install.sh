#!/usr/bin/env bash
# Install or update catapult on the dev host (run as the dev user with sudo available).
#   deploy/install.sh            # from a checkout; copies it to /opt/catapult
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LITESTREAM_VERSION="${LITESTREAM_VERSION:-0.3.13}"

sudo install -d -o "$USER" -g "$USER" /opt/catapult
rsync -a --delete --exclude node_modules --exclude .git --exclude 'apps/desktop/src-tauri/target' "$SRC/" /opt/catapult/
(cd /opt/catapult && pnpm install --frozen-lockfile --prod=false && pnpm build)

# Litestream (continuous SQLite replication; guide principle 10). catapult owns its install and config.
if ! command -v litestream >/dev/null || ! litestream version | grep -q "v${LITESTREAM_VERSION}"; then
    deb="litestream-v${LITESTREAM_VERSION}-linux-$(dpkg --print-architecture).deb"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/$deb" "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/$deb"
    sudo dpkg -i "$tmp/$deb"
    rm -rf "$tmp"
fi
sudo install -m 0644 "$SRC/deploy/litestream.yml" /etc/litestream.yml

sudo install -m 0644 "$SRC/deploy/catapult.service" /etc/systemd/system/catapult.service
sudo install -m 0644 "$SRC/deploy/litestream.service" /etc/systemd/system/litestream.service
sudo systemctl daemon-reload
sudo systemctl enable catapult litestream
sudo systemctl restart catapult litestream
systemctl --no-pager status catapult litestream | grep -E '●|Active:'
