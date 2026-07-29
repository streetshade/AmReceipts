variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for created resource names/tags."
  type        = string
  default     = "amreceipts"
}

variable "instance_type" {
  description = "EC2 instance type. t3.medium (x86) or t4g.medium (arm64) recommended."
  type        = string
  default     = "t3.medium"
}

variable "architecture" {
  description = "AMI architecture; must match instance_type. amd64 for t3/c6i, arm64 for t4g/c7g."
  type        = string
  default     = "amd64"
  validation {
    condition     = contains(["amd64", "arm64"], var.architecture)
    error_message = "architecture must be amd64 or arm64."
  }
}

variable "key_name" {
  description = "Name of an existing EC2 key pair for SSH access."
  type        = string
}

variable "ssh_cidr" {
  description = "CIDR allowed to SSH (port 22). Restrict to your IP, e.g. 203.0.113.4/32."
  type        = string
}

variable "root_volume_gb" {
  description = "Root EBS (gp3) size in GiB."
  type        = number
  default     = 30
}

variable "associate_eip" {
  description = "Allocate and attach an Elastic IP so the public IP is stable for DNS."
  type        = bool
  default     = true
}

# ---- App / provisioning config (passed to cloud-init.sh) ----

variable "domain" {
  description = "Domain for the app, e.g. receipts.example.com. Leave empty to skip TLS on first boot."
  type        = string
  default     = ""
}

variable "letsencrypt_email" {
  description = "Email for Let's Encrypt (required to obtain a cert non-interactively)."
  type        = string
  default     = ""
}

variable "repo_url" {
  description = "Git repository URL to deploy."
  type        = string
  default     = "https://github.com/streetshade/AmReceipts.git"
}

variable "repo_branch" {
  description = "Branch (or tag) to deploy."
  type        = string
  default     = "claude/samaritech-amreceipts"
}

variable "git_token" {
  description = "Optional PAT (read access) if the repo is private. Stored in instance user-data — leave empty for public repos."
  type        = string
  default     = ""
  sensitive   = true
}

variable "ocr_provider" {
  description = "OCR backend: stub | tesseract | google-vision."
  type        = string
  default     = "stub"
}

variable "barcode_provider" {
  description = "Barcode lookup backend: upcitemdb | local."
  type        = string
  default     = "upcitemdb"
}
