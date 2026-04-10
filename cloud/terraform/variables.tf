variable "name" {
  description = "Unique name for this nectar instance (prefixes all resource names)"
  type        = string
  default     = "nectar"
}

variable "secret_name" {
  description = "Secrets Manager secret name for .env contents"
  type        = string
  default     = "nectar/env"
}

variable "env_name" {
  description = "Environment name for tagging"
  type        = string
  default     = "nectar"
}

variable "customer_name" {
  description = "Customer name for tagging"
  type        = string
  default     = "viv"
}

variable "vpc_id" {
  description = "VPC ID (Jenkins VPC — colocated with Jenkins master)"
  type        = string
  default     = "vpc-02651295c24f8bc7f" # jenkins-vpc
}

# ALB and EC2 subnets are created by network.tf as aws_subnet resources —
# not configured via variables. The subnets are 10.0.3.0/24 (us-east-1a) and
# 10.0.4.0/24 (us-east-1b), dedicated to nectar and other lightweight services.

variable "instance_type" {
  description = "EC2 instance type (t3.medium: 2 vCPU, 4 GB — headroom for Vite client build)"
  type        = string
  default     = "t3.medium"
}

variable "ami_id" {
  description = "Ubuntu 22.04 AMI ID"
  type        = string
  default     = "ami-04680790a315cd58d"
}

variable "key_name" {
  description = "SSH key pair name"
  type        = string
  default     = "jenkins"
}

variable "certificate_arn" {
  description = "ACM certificate ARN for *.vivtechnologies.com"
  type        = string
  default     = "arn:aws:acm:us-east-1:140947722076:certificate/2bd943c9-7692-430b-b46b-b9a5cee983f3"
}

variable "office_cidrs" {
  description = "Office IP CIDRs for ALB HTTPS access"
  type        = list(string)
  default = [
    "206.223.160.14/32", # beanfield (Toronto office)
    "72.137.131.6/32",   # rogers (Toronto office)
  ]
}

variable "office_ssh_sg_id" {
  description = "Existing office SSH security group in Jenkins VPC (allows port 22 from Toronto office IPs)"
  type        = string
  default     = "sg-043c84f65239ea620" # toronto-office-jenkins-ssh
}

variable "app_port" {
  description = "Port Nectar listens on inside the EC2 instance"
  type        = number
  default     = 4000
}

variable "ebs_volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 30
}

variable "repo_url" {
  description = "HTTPS URL of the nectar git repo (used by init.sh)"
  type        = string
  default     = "https://github.com/mavencare/nectar.git"
}
