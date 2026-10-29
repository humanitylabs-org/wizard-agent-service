# syntax=docker/dockerfile:1.7
# Packaging-only derivative. Source is staged with `git archive` at the exact
# public revision named by HERMES_REVISION; never COPY a running Hermes home.
FROM ghcr.io/humanitylabs-org/hermes-agent@sha256:312be4375a3c4b2ad5768ca6341e609fa28d206b089a401823816c0380dfd6e6
USER root
ARG HERMES_REVISION
# gh (Go) is not executed here: this amd64 image is built under emulation on an arm64 host, where
# Go binaries segfault intermittently. `gh --version` runs natively in the post-load check instead.
# No Debian sqlite3 CLI: the base image ships libsqlite3 3.53.4 in /usr/local/lib, and the
# Debian CLI (3.46) aborts with 'SQLite header and source version mismatch' against it.
RUN apt-get update && apt-get install -y --no-install-recommends gh jq && rm -rf /var/lib/apt/lists/*
RUN python3 -c 'import pathlib,shutil; root=pathlib.Path("/opt/hermes"); [(shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()) for p in root.iterdir() if p.name != ".venv"]'
COPY source/ /opt/hermes/
RUN uv pip install --python /opt/hermes/.venv/bin/python --no-cache -e /opt/hermes && \
    /opt/hermes/.venv/bin/python -c 'import hermes_cli.backup, gateway.run; import sqlite3; assert sqlite3.sqlite_version_info >= (3, 53, 4); from plugins.memory import load_memory_provider; p=load_memory_provider("holographic"); assert p is not None and p.is_available(), "stock holographic provider must be packaged"' && \
    git --version && dpkg-query -W gh && test -x /usr/bin/gh && ssh -V && jq --version && \
    /opt/hermes/.venv/bin/python -c 'import json,sys; c=json.load(open("/opt/hermes/install-stamp.json"))["commit"]; sys.exit(0 if c==sys.argv[1] else "install-stamp commit "+c+" != "+sys.argv[1])' "$HERMES_REVISION" && \
    /opt/hermes/.venv/bin/hermes --version
LABEL org.opencontainers.image.source="https://github.com/NousResearch/hermes-agent" \
      org.opencontainers.image.revision="${HERMES_REVISION}" \
      org.wizard.import.runtime="hermes-import-v1"
# Importer supplies its own fixed Python entrypoint, UID, HOME and HERMES_HOME.
# No host socket, source checkout, systemd directory or owner home is baked in.
