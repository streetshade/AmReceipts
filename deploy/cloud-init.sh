#!/usr/bin/env bash
#
# AmReceipts one-shot provisioner for a FRESH Debian 12 (bookworm) EC2 instance.
#
# Two ways to use it:
#   1. Manual: edit the CONFIG defaults below, then paste this whole file into the
#      EC2 "User data" field when launching the instance.
#   2. Terraform: the module in deploy/terraform/ prepends `export VAR=...` lines
#      and appends this script verbatim, so the values come from Terraform vars.
#
# It installs Node 20, PostgreSQL, nginx and the app; generates all secrets;
# builds, migrates and seeds; runs the app under systemd behind nginx; and (if a
# domain + email are given and DNS already points here) obtains a TLS cert.
#
# Progress is logged to /var/log/amreceipts-provision.log. A completion summary is
# written to /root/amreceipts-provision-summary.txt.

set -euo pipefail
exec > >(tee -a /var/log/amreceipts-provision.log) 2>&1
echo "=== AmReceipts provisioning started: $(date -u) ==="

# ============================ CONFIG (edit for manual use) ============================
: "${DOMAIN:=}"                       # e.g. receipts.example.com — leave empty to skip TLS
: "${LETSENCRYPT_EMAIL:=}"            # required to obtain a cert non-interactively
: "${REPO_URL:=https://github.com/streetshade/AmReceipts.git}"
: "${REPO_BRANCH:=claude/samaritech-amreceipts}"
: "${GIT_TOKEN:=}"                    # set only if the repo is PRIVATE (a PAT with read access)
: "${OCR_PROVIDER:=stub}"            # stub | tesseract | google-vision | documentai
: "${BARCODE_PROVIDER:=upcitemdb}"    # upcitemdb | local
# Document AI (only used when OCR_PROVIDER=documentai):
: "${DOCAI_LOCATION:=us}"             # us | eu (must match the processor's region)
: "${DOCAI_PROCESSOR_ID:=}"           # Expense/Invoice processor ID from the console
: "${DOCAI_PROJECT_ID:=}"             # optional; defaults to the credentials' project
# =====================================================================================

APP_DIR=/opt/amreceipts
ENV_DIR=/etc/amreceipts
ENV_FILE=$ENV_DIR/amreceipts.env
export DEBIAN_FRONTEND=noninteractive

# --- 1. Base packages + Node 20 ------------------------------------------------------
apt-get update
apt-get -y upgrade
apt-get install -y curl git ca-certificates gnupg nginx postgresql certbot python3-certbot-nginx ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
echo "Node $(node -v)"

# --- 2. Swap on small instances (next build needs ~2GB) ------------------------------
mem_mb=$(free -m | awk '/^Mem:/{print $2}')
if [ "$mem_mb" -lt 3000 ] && [ ! -f /swapfile ]; then
  echo "Low memory (${mem_mb}MB) — adding 2G swap for the build"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- 3. App user + code --------------------------------------------------------------
id amreceipts &>/dev/null || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin amreceipts
install -d -o amreceipts -g amreceipts "$APP_DIR"
clone_url="$REPO_URL"
if [ -n "$GIT_TOKEN" ]; then
  clone_url="https://x-access-token:${GIT_TOKEN}@${REPO_URL#https://}"
fi
# Clone in place. The home dir may contain skeleton dotfiles (or content from a
# prior run), so a plain `git clone <dir>` would fail ("destination not empty").
# git init + fetch + checkout -f populates the directory regardless.
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u amreceipts git -C "$APP_DIR" init -q
  sudo -u amreceipts git -C "$APP_DIR" remote add origin "$clone_url" 2>/dev/null \
    || sudo -u amreceipts git -C "$APP_DIR" remote set-url origin "$clone_url"
  sudo -u amreceipts git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
  sudo -u amreceipts git -C "$APP_DIR" checkout -f -b "$REPO_BRANCH" FETCH_HEAD
fi
cd "$APP_DIR"
# Install ALL dependencies including devDependencies. `--include=dev` is explicit
# on purpose: `next build` needs the build toolchain (typescript, tailwind, postcss,
# @types/*). If NODE_ENV=production is ever in scope, a bare `npm ci` silently omits
# devDependencies and the build then fails with misleading "Can't resolve '@/...'"
# module errors (Next only wires up the tsconfig path alias when TypeScript is present).
sudo -u amreceipts npm ci --include=dev

# --- 4. PostgreSQL (local) -----------------------------------------------------------
DB_PASS=$(openssl rand -hex 16)
sudo -u postgres psql <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='amreceipts') THEN
    CREATE ROLE amreceipts LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE amreceipts WITH PASSWORD '${DB_PASS}';
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='amreceipts'" | grep -q 1 \
  || sudo -u postgres createdb -O amreceipts amreceipts

# Switch Prisma datasource from sqlite to postgresql.
sed -i 's/provider = "sqlite"/provider = "postgresql"/' "$APP_DIR/prisma/schema.prisma"

# --- 5. Environment file (generated secrets) -----------------------------------------
mkdir -p "$ENV_DIR"
AUTH_SECRET=$(openssl rand -hex 32)
CRON_SECRET=$(openssl rand -hex 24)
cat > "$ENV_FILE" <<ENV
DATABASE_URL="postgresql://amreceipts:${DB_PASS}@127.0.0.1:5432/amreceipts?schema=public"
AUTH_SECRET="${AUTH_SECRET}"
CRON_SECRET="${CRON_SECRET}"
OCR_PROVIDER="${OCR_PROVIDER}"
GOOGLE_APPLICATION_CREDENTIALS="${ENV_DIR}/gcp-vision.json"
DOCAI_LOCATION="${DOCAI_LOCATION}"
DOCAI_PROCESSOR_ID="${DOCAI_PROCESSOR_ID}"
DOCAI_PROJECT_ID="${DOCAI_PROJECT_ID}"
BARCODE_PROVIDER="${BARCODE_PROVIDER}"
NODE_ENV="production"
PORT="3000"
ENV
chmod 600 "$ENV_FILE"
chown -R amreceipts:amreceipts "$ENV_DIR"

# --- 6. Build, migrate, seed ---------------------------------------------------------
sudo -u amreceipts --preserve-env=PATH bash -c '
  set -a; . '"$ENV_FILE"'; set +a
  cd '"$APP_DIR"'
  npm run build
  npx prisma db push
  npm run db:seed
'

# --- 7. systemd service --------------------------------------------------------------
cp "$APP_DIR/deploy/amreceipts.service" /etc/systemd/system/amreceipts.service
systemctl daemon-reload
systemctl enable --now amreceipts

# --- 8. nginx (HTTP first; certbot adds TLS) -----------------------------------------
server_name=${DOMAIN:-_}
cat > /etc/nginx/sites-available/amreceipts <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${server_name};
    client_max_body_size 15M;

    location /uploads/ {
        alias ${APP_DIR}/public/uploads/;
        expires 30d;
        access_log off;
    }
    location /_next/static/ {
        alias ${APP_DIR}/.next/static/;
        expires 1y;
        access_log off;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/amreceipts /etc/nginx/sites-enabled/amreceipts
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# --- 9. TLS (best effort; needs DNS already pointing at this host) -------------------
tls_note="TLS not configured (no domain/email given, or DNS not ready). To add it later, point DNS at this host, then:
  sudo sed -i 's/server_name _;/server_name YOUR.DOMAIN;/' /etc/nginx/sites-available/amreceipts
  sudo nginx -t && sudo systemctl reload nginx
  sudo certbot --nginx -d YOUR.DOMAIN --redirect"
if [ -n "$DOMAIN" ] && [ -n "$LETSENCRYPT_EMAIL" ]; then
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect; then
    tls_note="TLS configured for https://${DOMAIN}"
  else
    tls_note="certbot failed (DNS may not point here yet). Re-run once DNS resolves: sudo certbot --nginx -d ${DOMAIN}"
  fi
fi

# --- 10. Firewall --------------------------------------------------------------------
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# --- 11. Deferred-lookup retry cron --------------------------------------------------
if [ -n "$DOMAIN" ]; then
  echo "0 * * * * root curl -s -X POST -H 'x-cron-secret: ${CRON_SECRET}' https://${DOMAIN}/api/maintenance/retry-lookups >/dev/null 2>&1" \
    > /etc/cron.d/amreceipts-retry-lookups
fi

# --- 12. Nightly DB backup -----------------------------------------------------------
mkdir -p /var/backups/amreceipts
echo "0 2 * * * postgres pg_dump amreceipts | gzip > /var/backups/amreceipts/db-\$(date +\\%F).sql.gz" \
  > /etc/cron.d/amreceipts-db-backup

# --- Summary -------------------------------------------------------------------------
cat > /root/amreceipts-provision-summary.txt <<SUMMARY
AmReceipts provisioning complete: $(date -u)

URL:            ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://<this-host-ip>}
${tls_note}

Seeded demo accounts (all password123) — CHANGE THESE:
  admin@amreceipts.app     (admin)
  approver@amreceipts.app  (approver)
  demo@amreceipts.app      (user)

OCR provider:   ${OCR_PROVIDER}$([ "$OCR_PROVIDER" = google-vision ] && echo '  (upload the service-account key to '"$ENV_DIR"'/gcp-vision.json and: systemctl restart amreceipts)')
Env file:       ${ENV_FILE}
App logs:       journalctl -u amreceipts -f
DB backups:     /var/backups/amreceipts

Secrets (AUTH_SECRET, CRON_SECRET, DB password) were generated and stored in ${ENV_FILE}.
SUMMARY

echo "=== AmReceipts provisioning finished: $(date -u) ==="
cat /root/amreceipts-provision-summary.txt
