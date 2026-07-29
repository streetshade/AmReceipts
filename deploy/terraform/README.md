# AmReceipts — Terraform (AWS EC2)

Provisions a single EC2 instance that self-installs AmReceipts on first boot via
[`../cloud-init.sh`](../cloud-init.sh): security group, Elastic IP, gp3 volume,
IMDSv2, and the full app stack (Node 20 + PostgreSQL + nginx/TLS).

## Prerequisites

- Terraform ≥ 1.3 and AWS credentials configured (`aws configure` or env vars).
- An existing **EC2 key pair** (for SSH) — pass its name as `key_name`.
- A **domain** you can point at the instance (optional but needed for HTTPS/camera).

## Use

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # edit values
terraform init
terraform apply
```

After apply, Terraform prints `public_ip`, `ssh_command`, `app_url` and `next_steps`:

1. Point a DNS **A record** for your domain at `public_ip`.
2. First-boot provisioning takes ~3–6 min. Watch it:
   ```bash
   ssh admin@<public_ip>
   sudo tail -f /var/log/amreceipts-provision.log
   ```
3. If DNS wasn't ready when cloud-init ran, finish TLS manually:
   `sudo certbot --nginx -d <domain>`
4. **Rotate the seeded demo accounts** (`admin@`/`approver@`/`demo@amreceipts.app`).
5. For `ocr_provider = "google-vision"`, upload the service-account key to
   `/etc/amreceipts/gcp-vision.json` and `sudo systemctl restart amreceipts`.

## Notes

- **Instance size:** `t3.medium` (x86) or `t4g.medium` (`architecture = "arm64"`,
  cheaper) suit Vision/stub OCR. For on-device Tesseract use a `c`-family type.
  See [`../../docs/AWS-DEPLOYMENT.md`](../../docs/AWS-DEPLOYMENT.md) for the full sizing table.
- **Secrets:** the app's `AUTH_SECRET`, `CRON_SECRET` and DB password are generated
  **on the instance** by cloud-init — they are not in Terraform state. `git_token`
  (if set for a private repo) is passed via user-data and is marked sensitive; prefer
  a public repo or a short-lived token.
- **Default VPC:** deploys into the account's default VPC for simplicity. Adapt
  `main.tf` (subnet/VPC data sources) to place it in a specific network.
- **user-data runs once** (first boot only). Changing `cloud-init.sh` afterwards does
  not re-run it; update in place per `docs/AWS-DEPLOYMENT.md` §14, or taint/replace
  the instance.
- **Destroy:** `terraform destroy` (back up the DB + `public/uploads` first).

## Prefer CloudFormation?

An equivalent single-file template is at
[`../cloudformation.yaml`](../cloudformation.yaml).
