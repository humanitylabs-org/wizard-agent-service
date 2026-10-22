#!/usr/bin/env python3
"""Render an exact-alias Compose override; contains no credentials.
Run before compose when changing EGRESS_PASSTHROUGH_HOSTS, and load after compose.yml.
The Service uses this renderer too. YAML !override prevents additive alias merging.
"""
import json
import os
import re

DEFAULT_HOSTS = "api.anthropic.com platform.claude.com"


def compose_override(value):
    hosts = sorted(set(value.replace(",", " ").split()))
    if not hosts or any(len(h) > 253 or not re.fullmatch(r"[a-z][a-z0-9.-]*[a-z]", h)
                        or any(not label or len(label) > 63 for label in h.split(".")) for h in hosts):
        raise ValueError("invalid passthrough hosts")
    text = " ".join(hosts)
    return ("services:\n  egress:\n    environment:\n      EGRESS_PASSTHROUGH_HOSTS: " + json.dumps(text)
            + "\n      EGRESS_PASSTHROUGH_ALIASES: " + json.dumps(text)
            + "\n    networks:\n      sandbox:\n        aliases: !override " + json.dumps(hosts) + "\n")


if __name__ == "__main__":
    print(compose_override(os.environ.get("EGRESS_PASSTHROUGH_HOSTS", DEFAULT_HOSTS)), end="")
