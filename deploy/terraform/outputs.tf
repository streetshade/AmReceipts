output "public_ip" {
  description = "Public IP of the instance (Elastic IP if enabled)."
  value       = var.associate_eip ? aws_eip.app[0].public_ip : aws_instance.app.public_ip
}

output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.app.id
}

output "ssh_command" {
  description = "SSH into the instance (default Debian user is 'admin')."
  value       = "ssh admin@${var.associate_eip ? aws_eip.app[0].public_ip : aws_instance.app.public_ip}"
}

output "app_url" {
  description = "Where the app will be reachable once DNS + TLS are set."
  value       = var.domain != "" ? "https://${var.domain}" : "http://${var.associate_eip ? aws_eip.app[0].public_ip : aws_instance.app.public_ip}"
}

output "next_steps" {
  description = "Post-apply reminders."
  value = join("\n", [
    "1. Point a DNS A record for '${var.domain}' at the public_ip above.",
    "2. Provisioning runs on first boot (~3-6 min). Watch: ssh in, then 'sudo tail -f /var/log/amreceipts-provision.log'.",
    "3. If TLS didn't complete on first boot (DNS not ready), run: sudo certbot --nginx -d ${var.domain}",
    "4. Change/rotate the seeded demo accounts (admin@/approver@/demo@amreceipts.app).",
    var.ocr_provider == "google-vision" ? "5. Upload the Vision key to /etc/amreceipts/gcp-vision.json, then: sudo systemctl restart amreceipts" : "5. OCR provider is '${var.ocr_provider}'."
  ])
}
