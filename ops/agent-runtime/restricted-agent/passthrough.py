#!/usr/bin/env python3
"""Render an exact-alias Compose override; contains no credentials.
Run before compose when changing EGRESS_PASSTHROUGH_HOSTS, and load after compose.yml.
The Service uses this renderer too. YAML !override prevents additive alias merging.
"""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent / 'sidecars'))
from hostname_policy import valid_public_hostname

DEFAULT_HOSTS = "api.anthropic.com platform.claude.com"


def compose_override(value):
    hosts = sorted(set(value.replace(",", " ").split()))
    if not hosts or any(not valid_public_hostname(h) for h in hosts):
        raise ValueError("invalid passthrough hosts")
    text = " ".join(hosts)
    return ("services:\n  egress:\n    environment:\n      EGRESS_PASSTHROUGH_HOSTS: " + json.dumps(text)
            + "\n      EGRESS_PASSTHROUGH_ALIASES: " + json.dumps(text)
            + "\n    networks:\n      sandbox:\n        aliases: !override " + json.dumps(hosts) + "\n")


if __name__ == "__main__":
    print(compose_override(os.environ.get("EGRESS_PASSTHROUGH_HOSTS", DEFAULT_HOSTS)), end="")
