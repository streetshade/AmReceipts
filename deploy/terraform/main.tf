terraform {
  required_version = ">= 1.3"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# Latest official Debian 12 (bookworm) AMI for the chosen architecture.
data "aws_ami" "debian" {
  most_recent = true
  owners      = ["136693071363"] # Debian

  filter {
    name   = "name"
    values = ["debian-12-${var.architecture}-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

# Deploy into the account's default VPC (simplest single-box setup).
data "aws_vpc" "default" {
  default = true
}

resource "aws_security_group" "app" {
  name_prefix = "${var.name_prefix}-"
  description = "AmReceipts: SSH (restricted), HTTP, HTTPS"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_cidr]
  }
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-sg" }
}

# Provisioning script: Terraform-supplied config is exported first, then the
# repo's cloud-init.sh is appended verbatim (file() does not re-interpolate, so
# the script's own $VAR / $(...) bash survive untouched).
locals {
  user_data = <<-EOT
    #!/usr/bin/env bash
    export DOMAIN=${jsonencode(var.domain)}
    export LETSENCRYPT_EMAIL=${jsonencode(var.letsencrypt_email)}
    export REPO_URL=${jsonencode(var.repo_url)}
    export REPO_BRANCH=${jsonencode(var.repo_branch)}
    export GIT_TOKEN=${jsonencode(var.git_token)}
    export OCR_PROVIDER=${jsonencode(var.ocr_provider)}
    export BARCODE_PROVIDER=${jsonencode(var.barcode_provider)}
    ${file("${path.module}/../cloud-init.sh")}
  EOT
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.debian.id
  instance_type               = var.instance_type
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.app.id]
  associate_public_ip_address = true
  user_data                   = local.user_data

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  tags = { Name = "${var.name_prefix}-app" }
}

resource "aws_eip" "app" {
  count    = var.associate_eip ? 1 : 0
  instance = aws_instance.app.id
  domain   = "vpc"
  tags     = { Name = "${var.name_prefix}-eip" }
}
