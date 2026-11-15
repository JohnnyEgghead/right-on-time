# P3-BACKUP local proofs: a stand-in for the hosted server's host side (Debian 13, as the Lightsail instance), where
# backup.sh, restore-test.sh and retention.sh run with the host's Docker socket. Holds the same tools the server
# has: bash, GNU coreutils and find, util-linux (flock), the Docker CLI and the AWS CLI (Debian's awscli, as
# infra/hosted/setup.sh installs). Test-only: never shipped, never deployed.
# debian:trixie-20261005-slim (published Oct 6, 2026; the 14-day rule of REQUIREMENTS 543), multi-arch index digest.
FROM debian:trixie-20261005-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
RUN apt-get update -q \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
      bash coreutils findutils util-linux procps curl ca-certificates docker-cli awscli \
 && rm -rf /var/lib/apt/lists/*
