# Look up the shared internal-tools subnets managed outside this TF state.
#
# These subnets were created manually in the Jenkins VPC to hold always-on
# internal developer tooling (Nectar, potentially Hive, future services).
# They are NOT owned by nectar's terraform — we only consume them via Name tag.
#
# If you need to change them (resize, add more AZs, etc.), edit them in the
# owning tool/state, not here.
#
# Expected subnets (as of 2026-04-10):
#   internal-tools-1a — 10.0.3.0/24, us-east-1a, public (subnet-0d5dee6be35a20916)
#   internal-tools-1b — 10.0.4.0/24, us-east-1b, public (subnet-094867cafbdcc387d)

data "aws_subnet" "internal_tools_1a" {
  vpc_id = var.vpc_id

  filter {
    name   = "tag:Name"
    values = ["internal-tools-1a"]
  }
}

data "aws_subnet" "internal_tools_1b" {
  vpc_id = var.vpc_id

  filter {
    name   = "tag:Name"
    values = ["internal-tools-1b"]
  }
}
