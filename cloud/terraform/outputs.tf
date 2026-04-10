output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.nectar.id
}

output "instance_public_ip" {
  description = "EC2 public IP"
  value       = aws_instance.nectar.public_ip
}

output "instance_private_ip" {
  description = "EC2 private IP"
  value       = aws_instance.nectar.private_ip
}

output "alb_dns_name" {
  description = "ALB DNS name — create a CNAME for nectar.vivtechnologies.com pointing here"
  value       = aws_lb.nectar.dns_name
}

output "alb_arn" {
  description = "ALB ARN"
  value       = aws_lb.nectar.arn
}

output "ec2_role_arn" {
  description = "IAM role ARN attached to the EC2 instance"
  value       = aws_iam_role.nectar_ec2.arn
}
