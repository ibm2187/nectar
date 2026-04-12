# Security group for ALB — open to the world (dashboard has its own auth).
# EC2 SSH (port 22) is granted via the existing shared office SSH SG
# (toronto-office-jenkins-ssh) attached in ec2.tf — not defined here.

resource "aws_security_group" "nectar_alb" {
  name        = "${var.name}-alb-sg"
  description = "Nectar ALB - HTTPS from office IPs"
  vpc_id      = var.vpc_id

  tags = {
    Name        = "${var.name}-alb-sg"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.nectar_alb.id
  description       = "HTTPS from anywhere"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.nectar_alb.id
  description       = "HTTP from anywhere (redirects to HTTPS)"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_ec2" {
  security_group_id            = aws_security_group.nectar_alb.id
  description                  = "To EC2 on app port"
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.nectar_ec2.id
}

# Security group for EC2 — inbound from ALB on app port, all outbound
resource "aws_security_group" "nectar_ec2" {
  name        = "${var.name}-ec2-sg"
  description = "Nectar EC2 - inbound from ALB on app port"
  vpc_id      = var.vpc_id

  tags = {
    Name        = "${var.name}-ec2-sg"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_vpc_security_group_ingress_rule" "ec2_from_alb" {
  security_group_id            = aws_security_group.nectar_ec2.id
  description                  = "From ALB on app port"
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.nectar_alb.id
}

resource "aws_vpc_security_group_egress_rule" "ec2_all_outbound" {
  security_group_id = aws_security_group.nectar_ec2.id
  description       = "All outbound (GitHub, JIRA, Slack, live env polling)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
