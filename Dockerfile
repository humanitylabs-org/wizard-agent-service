# Headless Wizard Agent Service: the /wizard/... API, runs, approvals, voice and the one app gateway.
# No shell assets: the Wizard shell (wizard-ux) is its own container and app.
FROM node:22-alpine
RUN apk add --no-cache python3 tini && mkdir -p /app /state && chown 1000:1000 /state
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY ops/settings.example.json ops/launcher.example.json ./ops/
# WIZARD_UX_API_COMPAT keeps <prefix>api/transcribe and api/route (native multipart voice) answered behind the shell.
ENV NODE_ENV=production \
    WIZARD_CONTAINER=1 \
    WIZARD_PORT=8787 \
    WIZARD_REQUIRE_CF_ACCESS=0 \
    WIZARD_JOINED_DELEGATION=prefer \
    WIZARD_STATIC_DIR=/app/no-shell \
    WIZARD_UX_PREFIX=wizard-os-home \
    WIZARD_UX_API_COMPAT=1 \
    HERMES_HOME=/state \
    WIZARD_OS_HOME=/state/wizard-os
USER 1000:1000
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/wizard/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.mjs"]
