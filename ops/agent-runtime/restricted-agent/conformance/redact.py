#!/usr/bin/env python3
"""Scrub receipt secrets, including Claude env values without requiring secret argv.
Usage: redact.py <dir> <synthetic-value>...
Never pass a real credential on the command line.
"""
import json
import pathlib
import re
import sys

TOKEN = "CLAUDE_CODE_OAUTH_TOKEN"


def redact(text, values=()):
    for value in values:
        if value:
            text = text.replace(value, "<redacted>")
    # Handles Docker Env strings, shell assignments, YAML and JSON key/value fields.
    pattern = rf'({TOKEN}["\x27]?\s*[:=]\s*["\x27]?)([^\s"\x27,\x7d]+)'
    return re.sub(pattern, lambda m: m[1] + "<redacted>", text)


def main():
    root, *values = sys.argv[1:]
    for path in pathlib.Path(root).glob("*"):
        if path.is_file():
            text = path.read_text(errors="replace")
            try:
                obj = json.loads(text)
            except ValueError:
                obj = None
            if obj is not None:
                def clean(value):
                    if isinstance(value, dict):
                        return {k: "<redacted>" if k == TOKEN else clean(v) for k, v in value.items()}
                    if isinstance(value, list):
                        return [clean(v) for v in value]
                    return redact(value, values) if isinstance(value, str) else value
                text = json.dumps(clean(obj), indent=1) + "\n"
            else:
                text = redact(text, values)
            path.write_text(text)


if __name__ == "__main__":
    main()
