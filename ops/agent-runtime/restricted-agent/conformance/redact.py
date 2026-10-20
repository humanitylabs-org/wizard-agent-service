#!/usr/bin/env python3
"""Replace synthetic canary/token/key values in every receipt file with <synthetic>.
Usage: redact.py <dir> <value>..."""
import pathlib
import sys

root, *values = sys.argv[1:]
for path in pathlib.Path(root).glob("*"):
    if path.is_file():
        text = path.read_text(errors="replace")
        for value in values:
            text = text.replace(value, "<synthetic>")
        path.write_text(text)
