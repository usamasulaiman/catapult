#!/usr/bin/env bash
# Install or update catapult on the dev host (run as the dev user with sudo available).
#   deploy/install.sh            # from a checkout; copies it to /opt/catapult
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sudo install -d -o "$USER" -g "$USER" /opt/catapult
rsync -a --delete --exclude node_modules --exclude .git "$SRC/" /opt/catapult/
(cd /opt/catapult && pnpm install --frozen-lockfile --prod=false)

sudo install -m 0644 "$SRC/deploy/catapult.service" /etc/systemd/system/catapult.service
sudo systemctl daemon-reload
sudo systemctl enable catapult
sudo systemctl restart catapult
systemctl --no-pager status catapult | head -5
