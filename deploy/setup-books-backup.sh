#!/usr/bin/env bash
# One-time host setup for the books file backup (section 5): rclone copies each
# user's book files (chapters, images, source epubs) to the same R2 bucket the
# Litestream databases go to. Reuses the existing Litestream R2 token, so no
# secret is typed by hand. Run as root (sudo). Idempotent.
set -euo pipefail

LITESTREAM_ENV=/etc/unblent-litestream/r2.env
RCLONE_ENV=/etc/unblent-rclone/r2.env
UNITS_SRC=/opt/unblent/deploy/systemd

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }
[ -r "$LITESTREAM_ENV" ] || { echo "Missing $LITESTREAM_ENV (Litestream creds)" >&2; exit 1; }
# Ubuntu's rclone (1.60) checks each upload with a request R2 refuses (501), so
# every run fails and sends the same files again; the release from rclone.org works.
command -v rclone >/dev/null || { echo "rclone not installed: the .deb from https://rclone.org/downloads/" >&2; exit 1; }

# 1. Credentials file for rclone, derived from Litestream's, root-only.
# The endpoint carries the R2 account id, so it stays in the env and out of git.
set -a; . "$LITESTREAM_ENV"; set +a
: "${LITESTREAM_ENDPOINT:?missing from $LITESTREAM_ENV}"
umask 077
mkdir -p "$(dirname "$RCLONE_ENV")"
cat > "$RCLONE_ENV" <<EOF
RCLONE_CONFIG_R2_TYPE=s3
RCLONE_CONFIG_R2_PROVIDER=Cloudflare
RCLONE_CONFIG_R2_ACCESS_KEY_ID=${LITESTREAM_ACCESS_KEY_ID}
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${LITESTREAM_SECRET_ACCESS_KEY}
RCLONE_CONFIG_R2_ENDPOINT=${LITESTREAM_ENDPOINT}
EOF
chmod 600 "$RCLONE_ENV"
echo "wrote $RCLONE_ENV (mode 600)"

# 2. Install and enable the timer.
cp "$UNITS_SRC/unblent-books-backup.service" "$UNITS_SRC/unblent-books-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now unblent-books-backup.timer

# 3. Run the copy once now and report.
systemctl start unblent-books-backup.service
echo "--- last backup run ---"
journalctl -u unblent-books-backup --no-pager | tail -20
echo "--- timer ---"
systemctl status unblent-books-backup.timer --no-pager | grep -E "Active|Trigger" || true
