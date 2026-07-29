# Deploying AmReceipts on AWS EC2 (clean Debian)

End-to-end instructions to run AmReceipts on a single fresh **Debian 12 (bookworm)**
EC2 instance: PostgreSQL + the app + nginx/TLS, all on one box. Copy-paste friendly.

> **Why one box?** AmReceipts is a modest SSR app. A single instance running the
> app, PostgreSQL and nginx is the simplest, cheapest, and entirely sufficient
> setup for a team of tens of users. Split PostgreSQL onto RDS and put images on
> S3 only when you outgrow it (see [Scaling later](#12-scaling-later)).

> **Prefer automation?** Skip the manual steps entirely:
> - **Terraform** — [`deploy/terraform/`](../deploy/terraform/) creates the security
>   group, Elastic IP and instance, which self-provisions on first boot.
> - **CloudFormation** — [`deploy/cloudformation.yaml`](../deploy/cloudformation.yaml).
> - **cloud-init only** — paste [`deploy/cloud-init.sh`](../deploy/cloud-init.sh) into
>   the EC2 *User data* field when launching any Debian 12 instance.
>
> All three run the same [`deploy/cloud-init.sh`](../deploy/cloud-init.sh), which
> generates all secrets on the instance, installs the full stack, and (given a domain
> + email with DNS already pointing at the host) obtains a TLS cert. The rest of this
> document is the **manual** walkthrough and the reference for what that script does.

---

## 1. Choosing the EC2 instance

The app is light: Node SSR + PostgreSQL + nginx. The **only** heavy CPU cost is
**on-device OCR** (`OCR_PROVIDER=tesseract`). If you use **Google Cloud Vision**
(recommended) or the offline stub, OCR runs off-box and the instance stays idle
most of the time — a perfect fit for **burstable T-series** instances.

| Scenario | Recommended | vCPU / RAM | Notes |
|---|---|---|---|
| **Recommended default** (Vision or stub OCR) | **`t3.medium`** | 2 / 4 GiB | Comfortable for app + Postgres + `next build`. |
| **Best value** (same, ARM/Graviton) | **`t4g.medium`** | 2 / 4 GiB | ~20% cheaper than t3.medium; all deps support arm64. Use the **arm64** AMI. |
| **Budget / pilot** (≤10 users) | `t3.small` | 2 / 2 GiB | Works, but 2 GiB is tight for `next build` — **add swap** (§4) or build off-box. |
| **On-device Tesseract OCR** | `c7i.large` / `c6i.large` (or `t3.large` unlimited) | 2 / 4–8 GiB | OCR is CPU-bound; a compute-optimized, non-burstable instance avoids throttling under concurrent scans. |

**Guidance**

- **Start with `t3.medium`** (x86) or **`t4g.medium`** (ARM, cheaper). Both handle
  a real field team comfortably when OCR is offloaded to Google Vision.
- **Burst credits:** T-instances throttle if sustained CPU exceeds the baseline.
  For Vision/stub OCR you'll rarely hit it. If you run Tesseract on-box, either
  enable **T3 "unlimited"** mode or move to a `c`-family instance.
- **RAM reality check:** `next build` peaks around **1.5–2 GiB**. Runtime is small
  (Node ~150–300 MB, Postgres idle ~50–150 MB). 4 GiB is comfortable; 2 GiB needs swap.
- **Architecture:** ARM (Graviton, `t4g`/`c7g`) is fully supported — `bcryptjs`,
  `pdfkit`, `tesseract.js` (WASM), Prisma and `@google-cloud/vision` all provide
  arm64 builds. Just pick the arm64 Debian AMI.

**Storage:** one **gp3** EBS root volume, **30 GiB** to start (OS ~3 GB, `node_modules`
~1–2 GB, PostgreSQL, plus receipt/product images under `public/uploads` which grow
over time). gp3's default 3,000 IOPS / 125 MB/s is plenty. Monitor disk and grow the
volume, or move uploads to S3, as image volume increases.

---

## 2. Launch the instance

In the EC2 console (or CLI):

1. **AMI:** search Community AMIs for **`debian-12-amd64-*`** (or `debian-12-arm64-*`
   for Graviton), published by Debian (owner `136693071363`). Or use the
   **Debian 12** listing on AWS Marketplace.
2. **Instance type:** `t3.medium` (or `t4g.medium` for arm64).
3. **Key pair:** create/select an SSH key pair; download the `.pem`.
4. **Storage:** 30 GiB gp3.
5. **Network / security group** — inbound rules:
   - **22 (SSH)** — source: **your IP only** (`x.x.x.x/32`).
   - **80 (HTTP)** — `0.0.0.0/0` (Let's Encrypt + redirect to HTTPS).
   - **443 (HTTPS)** — `0.0.0.0/0`.
   Outbound: allow all (needed for apt, npm, Let's Encrypt, upcitemdb, Google Vision).
6. **Elastic IP:** allocate one and associate it, so the public IP is stable for DNS.
7. **DNS:** point an `A` record (e.g. `receipts.example.com`) at the Elastic IP.

The default SSH user on Debian AMIs is **`admin`**:

```bash
chmod 400 your-key.pem
ssh -i your-key.pem admin@receipts.example.com
```

---

## 3. Base OS packages

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y curl git ca-certificates gnupg nginx postgresql \
  certbot python3-certbot-nginx ufw

# Node.js 20 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v20.x
```

---

## 4. (Small instances only) add swap

Skip on ≥4 GiB. On a 2 GiB instance this prevents `next build` from being OOM-killed:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 5. Application user and code

```bash
sudo useradd --system --home-dir /opt/amreceipts --shell /usr/sbin/nologin amreceipts
sudo install -d -o amreceipts -g amreceipts /opt/amreceipts   # empty, owned dir (git clone needs it empty)
sudo -u amreceipts git clone https://github.com/streetshade/AmReceipts.git /opt/amreceipts
cd /opt/amreceipts
sudo -u amreceipts git checkout claude/samaritech-amreceipts   # or your release branch/tag
sudo -u amreceipts npm ci     # full install (build needs devDeps: prisma, tailwind, tsx)
```

---

## 6. PostgreSQL database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER amreceipts WITH PASSWORD 'CHANGE_ME_STRONG';
CREATE DATABASE amreceipts OWNER amreceipts;
SQL
```

Switch Prisma from SQLite to PostgreSQL — edit `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"   // was "sqlite"
  url      = env("DATABASE_URL")
}
```

```bash
sudo -u amreceipts sed -i 's/provider = "sqlite"/provider = "postgresql"/' /opt/amreceipts/prisma/schema.prisma
```

---

## 7. Environment file

```bash
sudo mkdir -p /etc/amreceipts
sudo install -Dm600 /opt/amreceipts/deploy/amreceipts.env.example /etc/amreceipts/amreceipts.env
sudo chown -R amreceipts:amreceipts /etc/amreceipts
sudo nano /etc/amreceipts/amreceipts.env       # fill in the values below
openssl rand -hex 32                            # value for AUTH_SECRET
openssl rand -hex 24                            # value for CRON_SECRET
```

Set at minimum:

```env
DATABASE_URL="postgresql://amreceipts:CHANGE_ME_STRONG@127.0.0.1:5432/amreceipts?schema=public"
AUTH_SECRET="<openssl rand -hex 32>"
CRON_SECRET="<openssl rand -hex 24>"
OCR_PROVIDER="google-vision"          # or "tesseract" / "stub"
GOOGLE_APPLICATION_CREDENTIALS="/etc/amreceipts/gcp-vision.json"
BARCODE_PROVIDER="upcitemdb"
NODE_ENV="production"
PORT="3000"
```

---

## 8. Build, migrate, seed

```bash
cd /opt/amreceipts
sudo -u amreceipts --preserve-env=PATH bash -c '
  set -a; . /etc/amreceipts/amreceipts.env; set +a
  npm run build            # prisma generate + next build
  npx prisma db push       # create the PostgreSQL schema
  npm run db:seed          # hardware catalogue, demo accounts, reasons, PSA Web stub
'
```

> The seed creates demo accounts (`admin@`, `approver@`, `demo@amreceipts.app`,
> all `password123`). **Change or delete these before real use** — at minimum sign
> in as admin and rotate them.

---

## 9. Run as a service (systemd)

```bash
sudo cp /opt/amreceipts/deploy/amreceipts.service /etc/systemd/system/amreceipts.service
sudo systemctl daemon-reload
sudo systemctl enable --now amreceipts
systemctl status amreceipts --no-pager
journalctl -u amreceipts -f          # live logs
```

The app now listens on `127.0.0.1:3000` (localhost only; nginx faces the internet).

---

## 10. nginx + HTTPS

TLS is **required** — browsers only allow camera access (receipt capture, live
barcode scanning) over HTTPS or `localhost`.

```bash
sudo cp /opt/amreceipts/deploy/nginx-amreceipts.conf /etc/nginx/sites-available/amreceipts
sudo sed -i 's/receipts.example.com/YOUR.DOMAIN/g' /etc/nginx/sites-available/amreceipts
sudo ln -s /etc/nginx/sites-available/amreceipts /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d YOUR.DOMAIN     # obtains + installs the cert, enables renewal
```

The provided nginx config serves `/uploads/` and `/_next/static/` directly from disk
and proxies everything else to the app, with `client_max_body_size 15M` for receipt
uploads. Visit `https://YOUR.DOMAIN` and sign in.

---

## 11. OCR provider setup (Google Cloud Vision)

**Google Vision is the default** OCR backend for the automated tooling
(`cloud-init.sh`, Terraform, CloudFormation). To make a fresh instance do real OCR
the moment it boots:

1. In Google Cloud Console: create/select a project, **enable the Cloud Vision API**,
   and ensure **billing** is on (Vision has a free monthly tier, then per-1,000-image
   pricing).
2. Create a **service account** with role **Cloud Vision API User** and download a
   **JSON key**.
3. Deliver the key **at launch** so no manual step is needed:
   - **Terraform:** set `gcp_vision_key_file = "./gcp-vision.json"`.
   - **CloudFormation:** pass `VisionKeyB64` = `base64 -w0 gcp-vision.json`.
   - **Raw cloud-init:** set `GCP_VISION_KEY_B64` (base64 of the JSON) in the CONFIG
     block. cloud-init writes it to `/etc/amreceipts/gcp-vision.json` on boot.

   Or add it **after boot** (also works if you left the key empty at launch):
   ```bash
   sudo install -Dm600 gcp-vision.json /etc/amreceipts/gcp-vision.json
   sudo chown amreceipts:amreceipts /etc/amreceipts/gcp-vision.json
   sudo systemctl restart amreceipts
   ```
   The env's `GOOGLE_APPLICATION_CREDENTIALS` already points at that path. If Vision
   is selected but no key is present, receipts still upload but OCR fails gracefully
   (enter details manually) until the key is added.

**Alternatives:** `OCR_PROVIDER=tesseract` runs OCR on-box (no external service, but
CPU-heavy — size accordingly, §1). `OCR_PROVIDER=stub` is deterministic/offline for
demos. Barcode lookups (`BARCODE_PROVIDER=upcitemdb`) need outbound HTTPS to
`api.upcitemdb.com`; on the free tier, over-limit lookups defer and retry after 24h.

### Deferred-lookup retry cron

```bash
sudo crontab -e
# hourly: process barcode lookups deferred by the upcitemdb daily limit
0 * * * * curl -s -X POST -H "x-cron-secret: YOUR_CRON_SECRET" \
  https://YOUR.DOMAIN/api/maintenance/retry-lookups >/dev/null
```

---

## 12. Firewall & hardening

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # opens 80 + 443
sudo ufw --force enable
sudo ufw status
```

- The app port **3000 stays bound to localhost** — never expose it in the security group.
- Keep SSH (22) restricted to your IP in the EC2 security group.
- Secrets live in `/etc/amreceipts/*` at mode `600`, owned by `amreceipts`.
- Enable **unattended-upgrades** for security patches:
  `sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`.
- Optional: `sudo apt install -y fail2ban` for SSH brute-force protection.

---

## 13. Backups

Two things to back up: the **database** and the **uploads** (receipt + product images).

```bash
# Nightly Postgres dump (as a cron for the postgres user)
sudo -u postgres bash -c 'mkdir -p /var/backups/amreceipts'
echo '0 2 * * * postgres pg_dump amreceipts | gzip > /var/backups/amreceipts/db-$(date +\%F).sql.gz' \
  | sudo tee /etc/cron.d/amreceipts-db-backup

# Uploads live here:
#   /opt/amreceipts/public/uploads
# Sync to S3 (install awscli and configure an IAM role/keys first):
#   aws s3 sync /opt/amreceipts/public/uploads s3://your-bucket/amreceipts-uploads
```

Consider an **EBS snapshot** schedule (AWS Backup / Data Lifecycle Manager) for a
whole-volume safety net. Restore a dump with
`gunzip -c db-YYYY-MM-DD.sql.gz | sudo -u postgres psql amreceipts`.

---

## 14. Updating the app

```bash
cd /opt/amreceipts
sudo -u amreceipts git pull        # or checkout the new release branch/tag
sudo -u amreceipts npm ci
sudo -u amreceipts --preserve-env=PATH bash -c '
  set -a; . /etc/amreceipts/amreceipts.env; set +a
  npm run build && npx prisma db push
'
sudo systemctl restart amreceipts
```

---

## 15. Scaling later

You're on one box; grow only when needed:

- **Database → Amazon RDS for PostgreSQL** — point `DATABASE_URL` at the RDS endpoint,
  put RDS in a private subnet, allow 5432 only from the instance's security group.
- **Uploads → S3** — move `public/uploads` to an S3 bucket (front with CloudFront) so
  the app tier is stateless and images survive instance replacement.
- **App tier → 2+ instances behind an ALB** — the app is stateless once DB and uploads
  are external; run it in an Auto Scaling Group across AZs and terminate TLS at the ALB.
- **Bigger single box** — simplest of all: resize (stop → change instance type → start),
  e.g. `t3.medium → t3.large` or a `c`-family type if you enable on-device Tesseract.

---

## 16. Rough monthly cost (us-east-1, on-demand, 24/7)

| Item | Approx / month |
|---|---|
| `t3.medium` (or `t4g.medium`, ~20% less) | ~$30 (~$24) |
| 30 GiB gp3 EBS | ~$2.40 |
| Elastic IP (while attached) | free |
| Data transfer (light) | a few $ |
| Google Vision OCR | free tier, then ~$1.50 / 1,000 images |
| upcitemdb | free trial tier (100/day), or paid plan |

A **1-year Compute Savings Plan** cuts the instance cost ~30–40%. On-device Tesseract
(no Vision bill) trades cloud OCR cost for a larger instance — usually not worth it
unless you can't use a cloud OCR provider.

---

## Quick reference

| Path | What |
|---|---|
| `/opt/amreceipts` | app code |
| `/etc/amreceipts/amreceipts.env` | environment (secrets, provider config) |
| `/etc/amreceipts/gcp-vision.json` | Google Vision service-account key |
| `/opt/amreceipts/public/uploads` | receipt + product images (back this up) |
| `deploy/amreceipts.service` | systemd unit |
| `deploy/nginx-amreceipts.conf` | nginx reverse proxy |
| `journalctl -u amreceipts -f` | app logs |
