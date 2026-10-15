# Runtime image for running the Agent Service of a systemd install inside its own container
# (ops/host-container/README.md). Code is NOT baked in: the container runs the release the deploy tool
# already installed (the launcher's WIZARD_CONTAINER_ENTRY), so deploys and rollbacks keep working
# unchanged. Match NODE_VERSION to the host's node; python3 runs the two stdlib session readers the
# service shells out to.
ARG NODE_VERSION=22.22.3
FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache python3 && python3 -c "import sqlite3,hashlib,json,re" && node --version
