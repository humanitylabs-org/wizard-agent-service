# Headless Wizard Agent Service. No shell assets or browser runtime.
FROM node:22-alpine
RUN apk add --no-cache python3 tini && mkdir -p /app /state && chown 1000:1000 /state
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY ops/settings.example.json ops/launcher.example.json ./ops/
ENV NODE_ENV=production WIZARD_CONTAINER=1 WIZARD_PORT=8787 WIZARD_REQUIRE_CF_ACCESS=0 WIZARD_JOINED_DELEGATION=prefer WIZARD_FOLLOW_THROUGH=off WIZARD_STATIC_DIR=/app/no-shell HERMES_HOME=/state WIZARD_OS_HOME=/state/wizard-os
USER 1000:1000
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/wizard/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.mjs"]
