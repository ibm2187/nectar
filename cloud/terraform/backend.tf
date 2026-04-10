terraform {
  backend "s3" {
    bucket         = "viv-infrastructure-backend"
    dynamodb_table = "viv-infrastructure-state-lock"
    key            = "viv/nectar"
    region         = "us-east-1"
  }
}
