# ALB for Nectar dashboard — internet-facing, HTTPS only, office IPs restricted via SG.

resource "aws_lb" "nectar" {
  name               = "${var.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.nectar_alb.id]
  subnets = [
    data.aws_subnet.internal_tools_1a.id,
    data.aws_subnet.internal_tools_1b.id,
  ]
  enable_deletion_protection = true

  tags = {
    Name        = "${var.name}-alb"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_lb_target_group" "nectar" {
  name        = "${var.name}-tg"
  port        = var.app_port
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/health"
    port                = tostring(var.app_port)
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  stickiness {
    type            = "lb_cookie"
    enabled         = true
    cookie_duration = 86400
  }

  tags = {
    Name        = "${var.name}-tg"
    environment = var.env_name
    customer    = var.customer_name
  }
}

resource "aws_lb_listener" "nectar_https" {
  load_balancer_arn = aws_lb.nectar.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.nectar.arn
  }
}

resource "aws_lb_listener" "nectar_http_redirect" {
  load_balancer_arn = aws_lb.nectar.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# Register EC2 instance with target group
resource "aws_lb_target_group_attachment" "nectar" {
  target_group_arn = aws_lb_target_group.nectar.arn
  target_id        = aws_instance.nectar.id
  port             = var.app_port
}
