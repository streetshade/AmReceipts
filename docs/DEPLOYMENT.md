# Deploying AmReceipts on Debian

> **Two ways to deploy.** The Docker path below is the recommended one for a new
> server: one image, no apt drift, and the thing CI builds is the thing that
> runs. The manual apt walkthrough that follows it still works and is what the
> existing deployment uses — keep it if you are already running that way.

## Docker (recommended)

Prerequisites on the AWS box: Docker Engine and the Compose plugin. On Ubuntu:

```bash
sudo apt update && sudo apt install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER    # log out and back in
```

Then, from a checkout of this repo:

```bash
export AUTH_SECRET=$(openssl rand -hex 32)
export CRON_SECRET=$(openssl rand -hex 32)

docker compose --profile migrate run --rm migrate   # create the schema
docker compose up --build -d                        # start the app
```

The database starts empty and `up` does **not** create it, so the migrate line
is required on first deploy and after any schema change. It is a separate step
rather than something the app does on boot because a container that migrates on
start races its own replicas the first time you run two.

Put nginx and certbot in front exactly as in the manual walkthrough below —
proxy to `127.0.0.1:3000` instead of the systemd service.

### What persists

Two named volumes, and nothing else survives a redeploy:

| Volume | Holds |
|---|---|
| `uploads` | receipt images and PDFs (`/app/public/uploads`) |
| `data` | the SQLite database (`/app/data`) |

Back these up. An image rebuild discards everything outside them.

### Postgres

SQLite is the default so `docker compose up` works with the committed schema.
For more than a handful of users, uncomment the `postgres` service in
`docker-compose.yml`, change `provider` in `prisma/schema.prisma` to
`"postgresql"`, point `DATABASE_URL` at it, and re-run the migrate step.

### Updating

```bash
git pull
docker compose --profile migrate run --rm migrate   # only if the schema changed
docker compose up --build -d
```

---

## Manual install (apt + systemd)

Target: Debian 12 (bookworm) or newer, running the app behind nginx with TLS,
managed by systemd, using PostgreSQL and Google Cloud Vision OCR.

> HTTPS is mandatory in production — browsers only grant camera access (receipt
> capture, live barcode scanning) over HTTPS or `localhost`.

## 1. System packages

```bash
sudo apt update
sudo apt install -y curl git nginx postgresql

# Node.js 20 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v20.x
```

## 2. Application user and code

```bash
sudo useradd --system --create-home --home-dir /opt/amreceipts --shell /usr/sbin/nologin amreceipts
sudo -u amreceipts git clone <your-repo-url> /opt/amreceipts
cd /opt/amreceipts
sudo -u amreceipts npm ci
```

## 3. PostgreSQL database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER amreceipts WITH PASSWORD 'CHANGE_ME';
CREATE DATABASE amreceipts OWNER amreceipts;
SQL
```

Switch Prisma to PostgreSQL by editing `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"   // was "sqlite"
  url      = env("DATABASE_URL")
}
```

## 4. Environment file

```bash
sudo mkdir -p /etc/amreceipts
sudo install -Dm600 deploy/amreceipts.env.example /etc/amreceipts/amreceipts.env
sudo chown -R amreceipts:amreceipts /etc/amreceipts
sudoedit /etc/amreceipts/amreceipts.env      # set DATABASE_URL, AUTH_SECRET, providers
openssl rand -hex 32                          # value for AUTH_SECRET
```

## 5. Google Cloud Vision OCR

1. In Google Cloud Console: create/select a project and **enable the Cloud Vision API**.
2. Create a **service account** with the role **Cloud Vision API User**.
3. Create a **JSON key** for it and copy it to the server:

```bash
sudo install -Dm600 gcp-vision.json /etc/amreceipts/gcp-vision.json
sudo chown amreceipts:amreceipts /etc/amreceipts/gcp-vision.json
```

Ensure the env file has:

```env
OCR_PROVIDER="google-vision"
GOOGLE_APPLICATION_CREDENTIALS="/etc/amreceipts/gcp-vision.json"
```

Billing must be enabled on the project; Vision includes a free monthly tier and
then bills per 1,000 images. On GCE/GKE with an attached service account you can
omit the key file entirely — the SDK uses the instance's credentials.

## 6. Build, migrate, seed

```bash
cd /opt/amreceipts
sudo -u amreceipts --preserve-env=PATH bash -c '
  set -a; . /etc/amreceipts/amreceipts.env; set +a
  npm run build
  npx prisma db push          # or: npx prisma migrate deploy
  npm run db:seed             # loads the hardware barcode catalogue
'
```

## 7. systemd service

```bash
sudo cp deploy/amreceipts.service /etc/systemd/system/amreceipts.service
sudo systemctl daemon-reload
sudo systemctl enable --now amreceipts
sudo systemctl status amreceipts
journalctl -u amreceipts -f
```

The app now listens on `127.0.0.1:3000`.

## 8. nginx + TLS

```bash
sudo cp deploy/nginx-amreceipts.conf /etc/nginx/sites-available/amreceipts
# edit server_name to your domain
sudo ln -s /etc/nginx/sites-available/amreceipts /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d receipts.example.com
```

Visit `https://receipts.example.com` and sign in with the seeded demo account
(`demo@amreceipts.app` / `password123`) or register.

## 9. Deferred-lookup retries (cron)

When upcitemdb's daily limit is hit, barcodes are queued for a retry 24h later.
Retries also run opportunistically on user activity, but a small cron ensures
they happen promptly even when idle. Set `CRON_SECRET` in the env file, then:

```bash
sudo crontab -e
# hourly: process any deferred lookups whose 24h window has elapsed
0 * * * * curl -s -X POST -H "x-cron-secret: YOUR_CRON_SECRET" \
  https://receipts.example.com/api/maintenance/retry-lookups >/dev/null
```

## 10. Updating

```bash
cd /opt/amreceipts
sudo -u amreceipts git pull
sudo -u amreceipts npm ci
sudo -u amreceipts --preserve-env=PATH bash -c '
  set -a; . /etc/amreceipts/amreceipts.env; set +a
  npm run build && npx prisma db push
'
sudo systemctl restart amreceipts
```

## Notes

- **Uploads**: receipt images are written to `/opt/amreceipts/public/uploads` and
  served directly by nginx. Back this directory up, or switch to S3/GCS for scale.
- **Firewall**: expose only 80/443 publicly (`ufw allow 'Nginx Full'`); the app
  port 3000 stays bound to localhost.
- **Barcode lookup**: `BARCODE_PROVIDER=upcitemdb` resolves barcodes not in the
  seeded catalogue via an online API and caches them into the database.
