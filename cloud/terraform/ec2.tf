# Nectar EC2 instance — t3.medium, Ubuntu 22.04, gp3 EBS.
# Lives in the shared internal-tools-1b subnet (10.0.4.0/24 in us-east-1b),
# looked up by tag name via data.aws_subnet in subnets.tf.
# User data runs init.sh once on first boot. Subsequent boots use systemd + boot.sh.

resource "aws_instance" "nectar" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  key_name                    = var.key_name
  iam_instance_profile        = aws_iam_instance_profile.nectar_ec2.name
  subnet_id                   = data.aws_subnet.internal_tools_1b.id
  associate_public_ip_address = true

  vpc_security_group_ids = [
    aws_security_group.nectar_ec2.id,
    var.office_ssh_sg_id, # SSH from Toronto office (port 22) via existing shared SG
  ]

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.ebs_volume_size
    delete_on_termination = false
    encrypted             = true

    tags = {
      Name        = "${var.name}-root"
      environment = var.env_name
      customer    = var.customer_name
    }
  }

  user_data = base64encode(templatefile("${path.module}/../scripts/init.sh", {
    repo_url = var.repo_url
  }))

  tags = {
    Name               = var.name
    environment        = var.env_name
    customer           = var.customer_name
    service            = "nectar"
    Project            = "nectar"
    nectar-secret-name = var.secret_name
  }

  lifecycle {
    ignore_changes = [
      user_data, # Only runs on first boot
      ami,       # Prevent accidental instance replacement
    ]
  }
}
